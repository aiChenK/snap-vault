package detector

import (
	"snap-vault/internal/api"
	"snap-vault/internal/scan"
)

// BranchType 同步分支类型
type BranchType string

const (
	BranchA BranchType = "BranchA_NoOp"        // 分支 A: 完全一致，秒级跳过
	BranchB BranchType = "BranchB_FastAppend"  // 分支 B: 纯时间戳递增新增，跳过拉取清单直接快速追加
	BranchC BranchType = "BranchC_Reconcile"   // 分支 C: 降级全量比对，拉取清单并双向对齐
)

// Decision 探测决策结果
type Decision struct {
	Branch      BranchType
	Description string
	DeltaFiles  []scan.LocalFile // 分支 B 命中时的纯新增文件
}

// Evaluate 根据本地扫描结果与远程聚合状态机计算应执行的分支
func Evaluate(local *scan.ScanResult, remote *api.CheckResponse) Decision {
	// 场景 0: 两边均为空
	if local.Count == 0 && remote.RemoteCount == 0 {
		return Decision{
			Branch:      BranchA,
			Description: "本地与远端均无截图，无需同步",
		}
	}

	// 分支 A 判定: 本地数量与远端完全相等，且最新时间戳一致
	if local.Count == remote.RemoteCount && local.LatestMtime == remote.RemoteLatestMtime {
		return Decision{
			Branch:      BranchA,
			Description: "本地与服务端完全一致 (数量与最新时间戳匹配)，无需拉取清单",
		}
	}

	// 分支 B 判定:
	// 条件 0: 服务端不存在比有效最新时间戳更新的删除墓碑
	//         (否则本地多出的文件可能是服务端已删除的残留，必须走全量对齐以传播删除，防止误判重传复活)
	// 条件 1: localCount > remoteCount
	// 条件 2: 筛选本地 mtime > remoteLatestMtime 的文件列表，其数量严格等于 localCount - remoteCount
	if local.Count > remote.RemoteCount && remote.RemoteDeletedLatestMtime <= remote.RemoteLatestMtime {
		expectedDelta := local.Count - remote.RemoteCount
		var deltaFiles []scan.LocalFile

		for _, f := range local.Files {
			if f.OrigMtime > remote.RemoteLatestMtime {
				deltaFiles = append(deltaFiles, f)
			}
		}

		if len(deltaFiles) == expectedDelta {
			return Decision{
				Branch:      BranchB,
				Description: "命中 Fast-Path 快速追加机制！新增截图均为单调递增，无需拉取服务端清单",
				DeltaFiles:  deltaFiles,
			}
		}
	}

	// 降级进入分支 C: 全量对齐
	return Decision{
		Branch:      BranchC,
		Description: "状态未命中快速路径，降级拉取服务端清单执行全量比对 (Full Reconcile)",
	}
}

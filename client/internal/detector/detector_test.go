package detector

import (
	"testing"

	"snap-vault/internal/api"
	"snap-vault/internal/scan"
)

func TestEvaluateBranchA(t *testing.T) {
	// 1. 两端皆空
	local0 := &scan.ScanResult{Count: 0, LatestMtime: 0, OldestMtime: 0}
	remote0 := &api.CheckResponse{RemoteCount: 0, RemoteLatestMtime: 0}
	dec0 := Evaluate(local0, remote0)
	if dec0.Branch != BranchA {
		t.Errorf("两端皆空应命中 BranchA，实际: %s", dec0.Branch)
	}

	// 2. 数量与时间戳完全匹配
	localEqual := &scan.ScanResult{Count: 50, LatestMtime: 1792000000, OldestMtime: 1791000000}
	remoteEqual := &api.CheckResponse{RemoteCount: 50, RemoteLatestMtime: 1792000000}
	decEqual := Evaluate(localEqual, remoteEqual)
	if decEqual.Branch != BranchA {
		t.Errorf("数量与最新时间戳相等应命中 BranchA，实际: %s", decEqual.Branch)
	}
}

func TestEvaluateBranchB_FastAppend(t *testing.T) {
	// 远端已有 3 张截图，最新时间戳为 1000
	remote := &api.CheckResponse{
		RemoteCount:       3,
		RemoteLatestMtime: 1000,
	}

	// 本地有 5 张截图：前 3 张 <= 1000，后 2 张 > 1000 (纯新增追加)
	local := &scan.ScanResult{
		Count:       5,
		LatestMtime: 1200,
		Files: []scan.LocalFile{
			{Key: "1.jpg", OrigMtime: 800},
			{Key: "2.jpg", OrigMtime: 900},
			{Key: "3.jpg", OrigMtime: 1000},
			{Key: "4.jpg", OrigMtime: 1100}, // 新增
			{Key: "5.jpg", OrigMtime: 1200}, // 新增
		},
	}

	dec := Evaluate(local, remote)
	if dec.Branch != BranchB {
		t.Fatalf("应命中 BranchB 快速追加，实际为: %s", dec.Branch)
	}
	if len(dec.DeltaFiles) != 2 {
		t.Fatalf("DeltaFiles 数量应严格为 2，实际为: %d", len(dec.DeltaFiles))
	}
	if dec.DeltaFiles[0].Key != "4.jpg" || dec.DeltaFiles[1].Key != "5.jpg" {
		t.Errorf("增量文件列表解析异常: %+v", dec.DeltaFiles)
	}
}

func TestEvaluateBranchB_BlockedByServerTombstone(t *testing.T) {
	// 场景 1: 服务端删除了最新一张 (mtime 1200)，本地仍保留
	// 数量差额与增量文件虽匹配 Branch B 条件，但存在比远端最新时间戳更新的墓碑，必须降级 Branch C
	remote := &api.CheckResponse{
		RemoteCount:              3,
		RemoteLatestMtime:        1000,
		RemoteDeletedLatestMtime: 1200,
	}
	local := &scan.ScanResult{
		Count:       4,
		LatestMtime: 1200,
		Files: []scan.LocalFile{
			{Key: "1.jpg", OrigMtime: 800},
			{Key: "2.jpg", OrigMtime: 900},
			{Key: "3.jpg", OrigMtime: 1000},
			{Key: "4.jpg", OrigMtime: 1200}, // 服务端已删除，本地残留
		},
	}
	dec := Evaluate(local, remote)
	if dec.Branch != BranchC {
		t.Errorf("存在比远端最新时间戳更新的墓碑时必须降级 BranchC，实际: %s", dec.Branch)
	}

	// 场景 2: 墓碑时间戳不晚于远端最新有效时间戳时，快速追加不受影响
	remoteFast := &api.CheckResponse{
		RemoteCount:              3,
		RemoteLatestMtime:        1000,
		RemoteDeletedLatestMtime: 700, // 删除的是旧文件，不阻塞快速路径
	}
	localFast := &scan.ScanResult{
		Count:       4,
		LatestMtime: 1100,
		Files: []scan.LocalFile{
			{Key: "a.jpg", OrigMtime: 800},
			{Key: "b.jpg", OrigMtime: 900},
			{Key: "c.jpg", OrigMtime: 1000},
			{Key: "e.jpg", OrigMtime: 1100}, // 纯新增
		},
	}
	decFast := Evaluate(localFast, remoteFast)
	if decFast.Branch != BranchB {
		t.Errorf("墓碑不新于远端最新时间戳时不应阻塞 BranchB，实际: %s", decFast.Branch)
	}
}

func TestEvaluateBranchC_Reconcile(t *testing.T) {
	// 场景 1: 本地少于远端 (发生了本地删除)
	remote1 := &api.CheckResponse{RemoteCount: 10, RemoteLatestMtime: 1000}
	local1 := &scan.ScanResult{Count: 8, LatestMtime: 1000}
	dec1 := Evaluate(local1, remote1)
	if dec1.Branch != BranchC {
		t.Errorf("本地数量少于远端应降级命中 BranchC，实际: %s", dec1.Branch)
	}

	// 场景 2: 本地多于远端，但差额与 mtime > remoteLatest 的文件数不符
	// 例如：远端 3 张 (最新 1000)，本地 4 张，但本地多出的并不是 >1000 的纯追加（比如拷入了历史老截图或删除了旧图加了新图）
	remote2 := &api.CheckResponse{RemoteCount: 3, RemoteLatestMtime: 1000}
	local2 := &scan.ScanResult{
		Count:       4,
		LatestMtime: 1000,
		Files: []scan.LocalFile{
			{Key: "1.jpg", OrigMtime: 700},
			{Key: "2.jpg", OrigMtime: 800},
			{Key: "3.jpg", OrigMtime: 900},
			{Key: "4.jpg", OrigMtime: 1000},
		},
	}
	dec2 := Evaluate(local2, remote2)
	if dec2.Branch != BranchC {
		t.Errorf("时间戳异常情况应降级命中 BranchC，实际: %s", dec2.Branch)
	}
}

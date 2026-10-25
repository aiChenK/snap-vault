package syncer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"snap-vault/internal/api"
	"snap-vault/internal/config"
	"snap-vault/internal/detector"
	"snap-vault/internal/imageproc"
	"snap-vault/internal/scan"
)

var (
	ErrCircuitBreakerTriggered = errors.New("触发删除安全熔断门槛：待删除比例超 20% 且数量 > 30 张，已安全终止")
)

// LocalTrashDirName 本地回退回收站目录名 (系统回收站不可用时使用；位于截图目录下，扫描器自动忽略隐藏目录)
const LocalTrashDirName = ".snapvault-trash"

// Syncer 同步调度与执行器
type Syncer struct {
	cfg       *config.Config
	apiClient *api.Client
}

// NewSyncer 创建同步调度器
func NewSyncer(cfg *config.Config) *Syncer {
	return &Syncer{
		cfg:       cfg,
		apiClient: api.NewClient(cfg.Server, cfg.Key),
	}
}

// Run 执行完整的同步生命周期
func (s *Syncer) Run() error {
	startTime := time.Now()
	fmt.Printf("[SnapVault] 正在扫描本地目录: %s ...\n", s.cfg.Dir)

	// 1. 本地扫描
	localScan, err := scan.ScanDirectory(s.cfg.Dir)
	if err != nil {
		return fmt.Errorf("本地目录扫描失败: %w", err)
	}
	fmt.Printf("[SnapVault] 本地发现 %d 张截图 (最新修改时间: %s)\n",
		localScan.Count, formatTimestamp(localScan.LatestMtime))

	// 2. 轻量聚合状态探测
	fmt.Printf("[SnapVault] 正在探测服务端状态 (机器名: %s) ...\n", s.cfg.Machine)
	checkResp, err := s.apiClient.Check(s.cfg.Machine)
	if err != nil {
		return fmt.Errorf("服务端探测请求失败: %w", err)
	}
	fmt.Printf("[SnapVault] 服务端状态: 已存 %d 张截图 (最新修改时间: %s)\n",
		checkResp.RemoteCount, formatTimestamp(checkResp.RemoteLatestMtime))

	// 3. 决策状态机判定
	decision := detector.Evaluate(localScan, checkResp)
	fmt.Printf("[决策状态机] %s\n", decision.Description)

	switch decision.Branch {
	case detector.BranchA:
		fmt.Printf("✓ 全部截图已为最新状态，无需传输 (耗时: %v)\n", time.Since(startTime))
		return nil

	case detector.BranchB:
		fmt.Printf("⚡ 启动 Fast-Path 快速追加！待上传增量截图: %d 张\n", len(decision.DeltaFiles))
		if s.cfg.DryRun {
			fmt.Println("[DryRun] 演练模式：跳过实际上传")
			return nil
		}
		if err := s.uploadFilesConcurrently(decision.DeltaFiles); err != nil {
			return err
		}
		fmt.Printf("🎉 快速追加完成！耗时: %v\n", time.Since(startTime))
		return nil

	case detector.BranchC:
		return s.executeReconcile(localScan, checkResp, startTime)

	default:
		return fmt.Errorf("未知决策分支: %s", decision.Branch)
	}
}

// executeReconcile 执行分支 C: 全量拉取清单对齐与熔断保护
func (s *Syncer) executeReconcile(localScan *scan.ScanResult, checkResp *api.CheckResponse, startTime time.Time) error {
	fmt.Println("[降级全量对齐] 正在从服务端下载完整清单 (GET /api/manifest)...")
	manifest, err := s.apiClient.GetManifest(s.cfg.Machine)
	if err != nil {
		return fmt.Errorf("拉取清单失败: %w", err)
	}

	// 构建远端有效集合与软删除墓碑集合
	remoteValidMap := make(map[string]api.ManifestItem)
	tombstoneMap := make(map[string]api.ManifestItem)
	for key, item := range manifest.Items {
		if item.DeletedAt == nil {
			remoteValidMap[key] = item
		} else {
			tombstoneMap[key] = item
		}
	}

	// 构建本地集合
	localMap := make(map[string]scan.LocalFile)
	for _, f := range localScan.Files {
		localMap[f.Key] = f
	}

	// 计算待上传集合: 本地存在，远端既不在有效集合也不在墓碑集合
	// (命中墓碑说明该文件已在服务端被删除，严禁重传复活，转而进入本地清理集合)
	var toUpload []scan.LocalFile
	for _, f := range localScan.Files {
		_, validExists := remoteValidMap[f.Key]
		_, tombstoneExists := tombstoneMap[f.Key]
		if !validExists && !tombstoneExists {
			toUpload = append(toUpload, f)
		}
	}

	// 计算待从服务端删除集合
	var toDelete []string
	for rKey := range remoteValidMap {
		if _, exists := localMap[rKey]; !exists {
			toDelete = append(toDelete, rKey)
		}
	}

	// 计算服务端已删除、需同步清理本地的集合 (删除双向传播)
	var toLocalTrash []scan.LocalFile
	for _, f := range localScan.Files {
		if _, tombstoneExists := tombstoneMap[f.Key]; tombstoneExists {
			toLocalTrash = append(toLocalTrash, f)
		}
	}

	fmt.Printf("[比对结果] 待上传: %d 张，待从服务端删除: %d 张，服务端已删除待本地清理: %d 张\n",
		len(toUpload), len(toDelete), len(toLocalTrash))

	// 安全熔断检查 1 (Deletion Circuit Breaker - 服务端方向)
	// 当待删除比例超过 20% 且数量大于 30 张时，必须显式携带 -force-delete
	if len(toDelete) > 30 && float64(len(toDelete))/float64(checkResp.RemoteCount) > 0.20 {
		if !s.cfg.ForceDelete {
			fmt.Println("----------------------------------------------------------------------")
			fmt.Printf("⚠️  [安全熔断警告] 待删除数量 (%d 张) 超过服务端总数的 20%% 且大于 30 张！\n", len(toDelete))
			fmt.Println("这通常发生于：")
			fmt.Println("  1. 本地截图目录配置有误或移动了路径；")
			fmt.Println("  2. 用户无意间清空或更换了本地游戏截图文件夹。")
			fmt.Println("为防止误删云端备份，同步已自动熔断中止。")
			fmt.Println("如您确实在本地主动删除了这些截图，请加上 -force-delete 参数重新运行。")
			fmt.Println("----------------------------------------------------------------------")
			return ErrCircuitBreakerTriggered
		}
		fmt.Println("⚠️  已携带 -force-delete 参数，绕过熔断门槛继续执行同步删除。")
	}

	// 安全熔断检查 2 (Deletion Circuit Breaker - 本地方向)
	// 服务端删除传播到本地时同样受保护，防止服务端清单异常导致误清空本地目录
	if len(toLocalTrash) > 30 && float64(len(toLocalTrash))/float64(localScan.Count) > 0.20 {
		if !s.cfg.ForceDelete {
			fmt.Println("----------------------------------------------------------------------")
			fmt.Printf("⚠️  [安全熔断警告] 服务端已删除待本地清理数量 (%d 张) 超过本地总数的 20%% 且大于 30 张！\n", len(toLocalTrash))
			fmt.Println("这通常发生于：")
			fmt.Println("  1. 服务端清单被误操作或他人大量删除；")
			fmt.Println("  2. 本地目录与该机器名的服务端数据不匹配 (例如更换了机器名)。")
			fmt.Println("为防止误清空本地截图，同步已自动熔断中止。")
			fmt.Println("如您确实希望将这些本地文件移入回收站，请加上 -force-delete 参数重新运行。")
			fmt.Println("----------------------------------------------------------------------")
			return ErrCircuitBreakerTriggered
		}
		fmt.Println("⚠️  已携带 -force-delete 参数，绕过本地清理熔断门槛继续执行。")
	}

	if s.cfg.DryRun {
		fmt.Println("[DryRun] 演练模式：跳过实际删除与上传")
		return nil
	}

	// 执行服务端删除同步
	if len(toDelete) > 0 {
		fmt.Printf("[同步删除] 正在将 %d 个文件从服务端软删除至回收站...\n", len(toDelete))
		for i, delKey := range toDelete {
			if err := s.apiClient.Delete(s.cfg.Machine, delKey); err != nil {
				fmt.Printf("  [%d/%d] 删除失败 %s: %v\n", i+1, len(toDelete), delKey, err)
			} else {
				fmt.Printf("  [%d/%d] 已从远端同步移除: %s\n", i+1, len(toDelete), delKey)
			}
		}
	}

	// 执行服务端删除的本地传播: 优先移入系统回收站 (macOS 废纸篓 / Windows 回收站 / gio trash)，
	// 系统回收站不可用时回退至截图目录下的 .snapvault-trash 文件夹
	if len(toLocalTrash) > 0 {
		fmt.Printf("[本地清理] 正在将 %d 个服务端已删除的文件移入回收站 (优先系统回收站)...\n", len(toLocalTrash))
		for i, f := range toLocalTrash {
			sysErr := trashToSystem(f.OrigPath)
			if sysErr == nil {
				fmt.Printf("  [%d/%d] 已移入系统回收站: %s\n", i+1, len(toLocalTrash), f.OrigName)
				continue
			}
			dst, ferr := s.moveToLocalTrash(f)
			if ferr != nil {
				fmt.Printf("  [%d/%d] 移入回收站失败 %s (系统回收站: %v; 本地回收站: %v)\n",
					i+1, len(toLocalTrash), f.OrigName, sysErr, ferr)
			} else {
				fmt.Printf("  [%d/%d] 已移入本地回收站: %s\n", i+1, len(toLocalTrash), dst)
			}
		}
	}

	// 墓碑确认上报 (Tombstone GC): 本地已确认删除的墓碑通知服务端永久清除清单条目与回收站文件
	// 注: 本次同步新建的服务端墓碑 (上方 toDelete 产生) 不在 tombstoneMap 中，
	//     自然保留一个同步周期的服务端回收站恢复窗口，待下次同步确认
	var ackKeys []string
	for key := range tombstoneMap {
		if f, exists := localMap[key]; exists {
			// 本地扫描时仍存在该文件: 仅当本次已成功移入回收站 (文件已不存在) 时才确认
			if _, err := os.Stat(f.OrigPath); err == nil {
				continue // 移入回收站失败，保留墓碑待下次同步重试
			}
		}
		ackKeys = append(ackKeys, key)
	}
	if len(ackKeys) > 0 {
		if ackResp, err := s.apiClient.AckTombstones(s.cfg.Machine, ackKeys); err != nil {
			fmt.Printf("[墓碑确认] 上报失败 (下次同步将重试): %v\n", err)
		} else {
			fmt.Printf("[墓碑确认] 已确认 %d 个墓碑同步完成，服务端永久清除条目并清理回收站文件 %d 个\n",
				len(ackKeys), ackResp.TrashCleaned)
		}
	}

	// 执行增量上传
	if len(toUpload) > 0 {
		fmt.Printf("[增量上传] 正在上传 %d 张新增截图...\n", len(toUpload))
		if err := s.uploadFilesConcurrently(toUpload); err != nil {
			return err
		}
	}

	fmt.Printf("🎉 全量对齐完成！耗时: %v\n", time.Since(startTime))
	return nil
}

// moveToLocalTrash 将服务端已删除的本地文件移入截图目录下的回收站 (按日期分组，重名自动追加序号)
func (s *Syncer) moveToLocalTrash(f scan.LocalFile) (string, error) {
	trashDir := filepath.Join(s.cfg.Dir, LocalTrashDirName, time.Now().Format("20060102"))
	if err := os.MkdirAll(trashDir, 0755); err != nil {
		return "", fmt.Errorf("创建本地回收站目录失败: %w", err)
	}

	dst := filepath.Join(trashDir, f.OrigName)
	if _, err := os.Stat(dst); err == nil {
		ext := filepath.Ext(f.OrigName)
		base := strings.TrimSuffix(f.OrigName, ext)
		for i := 1; ; i++ {
			candidate := filepath.Join(trashDir, fmt.Sprintf("%s-%d%s", base, i, ext))
			if _, err := os.Stat(candidate); err != nil {
				dst = candidate
				break
			}
		}
	}

	if err := os.Rename(f.OrigPath, dst); err != nil {
		return "", err
	}
	return dst, nil
}

// uploadFilesConcurrently 并发上传任务池
func (s *Syncer) uploadFilesConcurrently(files []scan.LocalFile) error {
	total := len(files)
	if total == 0 {
		return nil
	}

	workerCount := s.cfg.Workers
	if workerCount <= 0 {
		workerCount = 2
	}
	if workerCount > 8 {
		workerCount = 8
	}

	taskCh := make(chan scan.LocalFile, total)
	for _, f := range files {
		taskCh <- f
	}
	close(taskCh)

	thumbCfg := imageproc.ParseThumbLevel(s.cfg.ThumbLevel)
	fmt.Printf("[图片转码] 缩略图等级: %s (尺寸 ≤ %dpx, 质量 %d)\n",
		thumbCfg.Level, thumbCfg.MaxDimension, thumbCfg.Quality)

	var completedCount int64
	var totalSavedBytes int64
	var wg sync.WaitGroup
	var uploadErr error
	var errOnce sync.Once

	for w := 1; w <= workerCount; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for file := range taskCh {
				// 客户端转码与生成缩略图 (去 EXIF)
				processed, err := imageproc.ProcessImage(file.OrigPath, thumbCfg)
				if err != nil {
					fmt.Printf("[Worker %d] 处理图片失败 %s: %v\n", workerID, file.OrigName, err)
					continue
				}

				// 上传到服务端
				params := api.UploadParams{
					Machine:   s.cfg.Machine,
					Key:       file.Key,
					OrigName:  file.OrigName,
					OrigSize:  file.OrigSize,
					OrigMtime: file.OrigMtime,
					FileData:  processed.JpegData,
					ThumbData: processed.ThumbData,
				}

				if err := s.apiClient.Upload(params); err != nil {
					fmt.Printf("[Worker %d] 上传失败 %s: %v\n", workerID, file.Key, err)
					errOnce.Do(func() {
						uploadErr = err
					})
					continue
				}

				idx := atomic.AddInt64(&completedCount, 1)
				saved := file.OrigSize - int64(len(processed.JpegData))
				if saved > 0 {
					atomic.AddInt64(&totalSavedBytes, saved)
				}

				fmt.Printf("[%d/%d] 上传成功: %s -> %s (原大小: %s, 转码后: %s, 缩略图: %s)\n",
					idx, total, file.OrigName, file.Key,
					formatBytes(file.OrigSize),
					formatBytes(int64(len(processed.JpegData))),
					formatBytes(int64(len(processed.ThumbData))),
				)
			}
		}(w)
	}

	wg.Wait()

	if uploadErr != nil {
		return fmt.Errorf("部分文件上传时出现异常: %w", uploadErr)
	}

	fmt.Printf("✓ 共完成 %d 张截图上传，客户端压缩节省带宽: %s\n", completedCount, formatBytes(totalSavedBytes))
	return nil
}

func formatTimestamp(ts int64) string {
	if ts <= 0 {
		return "无记录"
	}
	return time.Unix(ts, 0).Format("2006-01-02 15:04:05")
}

func formatBytes(b int64) string {
	if b <= 0 {
		return "0 B"
	}
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

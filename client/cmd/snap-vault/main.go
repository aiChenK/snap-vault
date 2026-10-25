package main

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"strings"

	"snap-vault/internal/config"
	"snap-vault/internal/syncer"
)

// version 通过构建脚本 -ldflags "-X main.version=vX.Y.Z" 注入，默认 dev
var version = "dev"

func main() {
	exitCode := 0
	// 在退出前拦截等待，防止 Windows 用户双击 exe 时窗口闪退
	defer func() {
		waitForExit()
		if exitCode != 0 {
			os.Exit(exitCode)
		}
	}()

	fmt.Println("----------------------------------------------------------------------")
	fmt.Printf("               SnapVault 游戏截图高速同步客户端 %s               \n", version)
	fmt.Println("----------------------------------------------------------------------")

	cfg, err := config.LoadConfig()
	if err != nil {
		fmt.Printf("\n[错误] 配置加载失败: %v\n", err)
		exitCode = 1
		return
	}

	fmt.Println("[配置详情]")
	fmt.Printf("  服务端地址: %s\n", cfg.Server)
	fmt.Printf("  机器标识符: %s\n", cfg.Machine)
	fmt.Printf("  截图目录:   %s\n", cfg.Dir)
	fmt.Printf("  并发线程:   %d\n", cfg.Workers)
	fmt.Printf("  缩略图等级: %s\n", cfg.ThumbLevel)
	if cfg.DryRun {
		fmt.Println("  运行模式:   演练 (DryRun)")
	}
	if cfg.ForceDelete {
		fmt.Println("  删除熔断:   已强制允许")
	}
	fmt.Println("----------------------------------------------------------------------")

	syncRunner := syncer.NewSyncer(cfg)
	if err := syncRunner.Run(); err != nil {
		fmt.Printf("\n[同步异常] %v\n", err)
		exitCode = 1
		return
	}

	fmt.Println("\n✓ 同步流程已圆满结束！")
}

// waitForExit 仅在 Windows 下等待回车，防止双击 exe 运行结束时窗口闪退。
// macOS / Linux 通常在终端或脚本 / cron 中运行，直接退出不阻塞流水线。
func waitForExit() {
	if runtime.GOOS != "windows" {
		return
	}
	// CI 环境无交互终端，跳过等待
	if strings.Contains(os.Getenv("CI"), "true") {
		return
	}
	fmt.Print("\n按回车键 (Enter) 退出程序...")
	reader := bufio.NewReader(os.Stdin)
	_, _ = reader.ReadString('\n')
}

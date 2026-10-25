package config

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Config 定义客户端运行配置
type Config struct {
	Server      string `json:"server"`
	Key         string `json:"key"`
	Machine     string `json:"machine"`
	Dir         string `json:"dir"`
	Workers     int    `json:"workers"`
	DryRun      bool   `json:"dry_run"`
	ForceDelete bool   `json:"force_delete"`
	ThumbLevel  string `json:"thumb_level,omitempty"`
}

const (
	DefaultConfigFileName = "config.json"
	DefaultWorkers        = 2
	DefaultThumbLevel     = "high"
)

// GenerateUniqueMachineName 提取系统主机名并净化，附加 4 字符随机短熵
func GenerateUniqueMachineName() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "desktop"
	}
	hostname = strings.ToLower(hostname)
	reg := regexp.MustCompile(`[^a-z0-9_-]+`)
	clean := reg.ReplaceAllString(hostname, "-")
	clean = strings.Trim(clean, "-")
	if clean == "" {
		clean = "machine"
	}
	if len(clean) > 20 {
		clean = clean[:20]
	}

	b := make([]byte, 2)
	_, _ = rand.Read(b)
	entropy := hex.EncodeToString(b)

	return fmt.Sprintf("%s-%s", clean, entropy)
}

// LoadConfig 解析配置：CLI 参数 > config.json > 交互式向导
func LoadConfig() (*Config, error) {
	var (
		serverFlag      string
		keyFlag         string
		machineFlag     string
		dirFlag         string
		workersFlag     int
		dryRunFlag      bool
		forceDeleteFlag bool
		thumbLevelFlag  string
		configPathFlag  string
	)

	flag.StringVar(&serverFlag, "server", "", "服务端 API 地址 (例如 http://127.0.0.1:3000)")
	flag.StringVar(&keyFlag, "key", "", "API 密钥 (X-API-Key)")
	flag.StringVar(&machineFlag, "machine", "", "计算机名称 (机器隔离标识)")
	flag.StringVar(&dirFlag, "dir", "", "本地截图目录路径")
	flag.IntVar(&workersFlag, "workers", DefaultWorkers, "并发上传线程数 (1~8)")
	flag.BoolVar(&dryRunFlag, "dry-run", false, "演练模式 (仅对比不上传不删除)")
	flag.BoolVar(&forceDeleteFlag, "force-delete", false, "强制删除 (绕过熔断门槛)")
	flag.StringVar(&thumbLevelFlag, "thumb-level", "", "缩略图画质等级: low(256px), medium(384px), high(512px, 默认), ultra(768px)")
	flag.StringVar(&configPathFlag, "config", DefaultConfigFileName, "配置文件路径")

	flag.Parse()

	// 1. 尝试从配置文件加载
	cfg := &Config{
		Workers:    DefaultWorkers,
		ThumbLevel: DefaultThumbLevel,
	}

	configExists := false
	if _, err := os.Stat(configPathFlag); err == nil {
		configExists = true
		data, err := os.ReadFile(configPathFlag)
		if err == nil {
			_ = json.Unmarshal(data, cfg)

			// 兼容处理：若未显式配置 thumb_level 但配置了 thumb_quality
			var rawMap map[string]interface{}
			if err := json.Unmarshal(data, &rawMap); err == nil {
				if _, hasLevel := rawMap["thumb_level"]; !hasLevel {
					if qVal, ok := rawMap["thumb_quality"]; ok && qVal != nil {
						cfg.ThumbLevel = fmt.Sprintf("%v", qVal)
					}
				}
			}
		}
	}

	// 2. 覆盖 CLI 显式参数
	if serverFlag != "" {
		cfg.Server = serverFlag
	}
	if keyFlag != "" {
		cfg.Key = keyFlag
	}
	if machineFlag != "" {
		cfg.Machine = machineFlag
	}
	if dirFlag != "" {
		cfg.Dir = dirFlag
	}
	if workersFlag > 0 {
		cfg.Workers = workersFlag
	}
	if dryRunFlag {
		cfg.DryRun = true
	}
	if forceDeleteFlag {
		cfg.ForceDelete = true
	}
	if thumbLevelFlag != "" {
		cfg.ThumbLevel = thumbLevelFlag
	}

	// 3. 校验必填项，如果不满足且无配置文件，触发终端首次运行向导
	if !configExists && (cfg.Server == "" || cfg.Key == "" || cfg.Machine == "" || cfg.Dir == "") {
		newCfg, err := RunOnboardingWizard(configPathFlag)
		if err != nil {
			return nil, err
		}
		// 合并 CLI 覆盖项
		if serverFlag != "" {
			newCfg.Server = serverFlag
		}
		if keyFlag != "" {
			newCfg.Key = keyFlag
		}
		if machineFlag != "" {
			newCfg.Machine = machineFlag
		}
		if dirFlag != "" {
			newCfg.Dir = dirFlag
		}
		if thumbLevelFlag != "" {
			newCfg.ThumbLevel = thumbLevelFlag
		}
		newCfg.DryRun = dryRunFlag
		newCfg.ForceDelete = forceDeleteFlag
		return newCfg, nil
	}

	// 规范化路径与配置
	if cfg.Server == "" || cfg.Key == "" || cfg.Machine == "" || cfg.Dir == "" {
		return nil, errors.New("缺少必要配置参数 (server, key, machine, dir)，可通过 CLI 传入或在 config.json 中配置")
	}

	cfg.Server = strings.TrimRight(cfg.Server, "/")
	if !strings.HasPrefix(cfg.Server, "http://") && !strings.HasPrefix(cfg.Server, "https://") {
		return nil, errors.New("服务端地址必须以 http:// 或 https:// 开头")
	}

	absDir, err := filepath.Abs(cfg.Dir)
	if err != nil {
		return nil, fmt.Errorf("解析截图目录失败: %w", err)
	}
	cfg.Dir = absDir

	if cfg.Workers <= 0 {
		cfg.Workers = DefaultWorkers
	}

	if strings.TrimSpace(cfg.ThumbLevel) == "" {
		cfg.ThumbLevel = DefaultThumbLevel
	}

	return cfg, nil
}

// RunOnboardingWizard 首次运行交互式配置向导
func RunOnboardingWizard(savePath string) (*Config, error) {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println("==================================================")
	fmt.Println("      欢迎使用 SnapVault 游戏截图同步客户端       ")
	fmt.Println("检测到本地尚未配置 config.json，现在开始首次引导设置")
	fmt.Println("==================================================")

	// 1. 服务端地址
	var server string
	for {
		fmt.Print("1. 请输入服务端 API 地址 (例如 http://192.168.1.100:3000): ")
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)
		input = strings.TrimRight(input, "/")
		if strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://") {
			server = input
			break
		}
		fmt.Println("   [错误] 地址格式不正确，必须以 http:// 或 https:// 开头，请重试。")
	}

	// 2. API Key
	var key string
	for {
		fmt.Print("2. 请输入 API 密钥 (API Key): ")
		input, _ := reader.ReadString('\n')
		key = strings.TrimSpace(input)
		if key != "" {
			break
		}
		fmt.Println("   [错误] 密钥不能为空，请重试。")
	}

	// 3. 本地截图目录
	currentDir, _ := filepath.Abs(".")
	var dir string
	for {
		fmt.Printf("3. 请输入截图本地目录路径 [直接回车使用当前目录: %s]: ", currentDir)
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)
		if input == "" {
			dir = currentDir
			break
		}
		abs, err := filepath.Abs(input)
		if err == nil {
			if fi, err := os.Stat(abs); err == nil && fi.IsDir() {
				dir = abs
				break
			}
		}
		fmt.Printf("   [错误] 目录不存在或无法访问 (%s)，请重试。\n", input)
	}

	// 4. 机器唯一名称
	autoName := GenerateUniqueMachineName()
	var machine string
	reg := regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	for {
		fmt.Printf("4. 请输入计算机名称 (用于多设备隔离存储) [直接回车使用: %s]: ", autoName)
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)
		if input == "" {
			machine = autoName
			break
		}
		if reg.MatchString(input) {
			machine = input
			break
		}
		fmt.Println("   [错误] 计算机名称仅支持 1~64 位的英文字母、数字、下划线及连字符，请重试。")
	}

	cfg := &Config{
		Server:      server,
		Key:         key,
		Machine:     machine,
		Dir:         dir,
		Workers:     DefaultWorkers,
		DryRun:      false,
		ForceDelete: false,
		ThumbLevel:  DefaultThumbLevel,
	}

	// 保存至文件
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("生成配置文件失败: %w", err)
	}

	if err := os.WriteFile(savePath, data, 0644); err != nil {
		return nil, fmt.Errorf("写入配置文件失败: %w", err)
	}

	fmt.Println("--------------------------------------------------")
	fmt.Printf("✓ 配置已成功保存至 %s！\n", savePath)
	fmt.Println("✓ 即刻自动开启首次无缝同步流程...")
	fmt.Println("==================================================")

	return cfg, nil
}

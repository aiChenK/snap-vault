package test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	serverPort = "3397"
	testAPIKey = "e2e-secret-key-999"
)

// generateTestImage 生成一张纯色测试 PNG 截图并写入指定时间戳
func generateTestImage(path string, w, h int, c color.RGBA, mtime int64) error {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	f.Close()

	if mtime > 0 {
		t := time.Unix(mtime, 0)
		return os.Chtimes(path, t, t)
	}
	return nil
}

// serverDeleteFile 通过 Web API 在服务端软删除指定文件
func serverDeleteFile(serverURL, apiKey, machine, key string) error {
	req, _ := http.NewRequest("DELETE", serverURL+"/api/file",
		strings.NewReader(fmt.Sprintf(`{"machine":"%s","key":"%s"}`, machine, key)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("服务端删除失败 HTTP %d", resp.StatusCode)
	}
	return nil
}

// remoteCount 查询服务端某机器的有效截图数量
func remoteCount(serverURL, apiKey, machine string) (int, error) {
	req, _ := http.NewRequest("POST", serverURL+"/api/check",
		strings.NewReader(fmt.Sprintf(`{"machine":"%s"}`, machine)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var data struct {
		RemoteCount int `json:"remoteCount"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return 0, err
	}
	return data.RemoteCount, nil
}

// runClient 运行客户端二进制，replaceEnv 中的键覆盖环境同名变量 (如 PATH=/nonexistent)
func runClient(bin, serverURL, apiKey, machine, dir string, replaceEnv ...string) (string, error) {
	env := make([]string, 0, len(os.Environ())+len(replaceEnv)+1)
	for _, kv := range os.Environ() {
		overridden := false
		for _, rep := range replaceEnv {
			key := strings.SplitN(rep, "=", 2)[0]
			if strings.HasPrefix(kv, key+"=") {
				overridden = true
				break
			}
		}
		if !overridden {
			env = append(env, kv)
		}
	}
	env = append(env, "CI=true")
	env = append(env, replaceEnv...)

	cmd := exec.Command(bin,
		"-server", serverURL,
		"-key", apiKey,
		"-machine", machine,
		"-dir", dir,
	)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestE2EScenarios(t *testing.T) {
	// 准备临时测试根目录
	baseDir, err := os.MkdirTemp("", "snapvault_e2e_*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(baseDir)

	serverDataDir := filepath.Join(baseDir, "server_data")
	clientScreenshotsDir := filepath.Join(baseDir, "screenshots")
	_ = os.MkdirAll(serverDataDir, 0755)
	_ = os.MkdirAll(clientScreenshotsDir, 0755)

	// 定位项目根目录
	cwd, _ := os.Getwd()
	// 如果在 client/test 目录下运行，项目根目录为 ../..
	projectRoot, _ := filepath.Abs(filepath.Join(cwd, "..", ".."))
	serverEntry := filepath.Join(projectRoot, "server", "src", "index.js")
	clientMainPkg := filepath.Join(projectRoot, "client", "cmd", "snap-vault")

	// 1. 启动服务端后台进程
	serverCmd := exec.Command("node", serverEntry)
	serverCmd.Dir = filepath.Join(projectRoot, "server")
	serverCmd.Env = append(os.Environ(),
		"PORT="+serverPort,
		"API_KEY="+testAPIKey,
		"DATA_DIR="+serverDataDir,
	)
	var serverOut bytes.Buffer
	serverCmd.Stdout = &serverOut
	serverCmd.Stderr = &serverOut

	if err := serverCmd.Start(); err != nil {
		t.Fatalf("启动测试服务端失败: %v", err)
	}
	defer func() {
		if serverCmd.Process != nil {
			_ = serverCmd.Process.Kill()
		}
	}()

	// 等待服务端启动就绪
	serverReady := false
	probeClient := &http.Client{
		Transport: &http.Transport{
			Proxy: nil, // 确保直连本地回环
		},
		Timeout: 1 * time.Second,
	}
	var lastProbeErr error
	for i := 0; i < 25; i++ {
		time.Sleep(200 * time.Millisecond)
		resp, err := probeClient.Get(fmt.Sprintf("http://127.0.0.1:%s/health", serverPort))
		if err == nil && resp.StatusCode == http.StatusOK {
			serverReady = true
			resp.Body.Close()
			break
		}
		lastProbeErr = err
	}
	if !serverReady {
		t.Fatalf("服务端启动超时 (最后错误: %v)，输出: %s", lastProbeErr, serverOut.String())
	}

	clientBin := filepath.Join(baseDir, "snap-vault-bin")
	buildCmd := exec.Command("go", "build", "-o", clientBin, clientMainPkg)
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("编译客户端失败: %v, 输出: %s", err, string(out))
	}

	machineName := "test-pc-01"
	serverURL := fmt.Sprintf("http://127.0.0.1:%s", serverPort)

	// ==========================================
	// 场景 0: 首次全新启动引导 (Onboarding Wizard)
	// ==========================================
	t.Log("[场景 0] 测试无配置文件时的首次交互式向导与保存...")
	wizardWorkingDir := filepath.Join(baseDir, "wizard_test")
	_ = os.MkdirAll(wizardWorkingDir, 0755)

	// 模拟终端输入：1. serverURL 2. key 3. 空(默认当前目录) 4. 空(默认自动机器名)
	wizardInput := fmt.Sprintf("%s\n%s\n\n\n", serverURL, testAPIKey)
	cmdWizard := exec.Command(clientBin)
	cmdWizard.Dir = wizardWorkingDir
	cmdWizard.Stdin = strings.NewReader(wizardInput)
	cmdWizard.Env = append(os.Environ(), "CI=true") // CI模式跳过回车防闪退

	outWizard, _ := cmdWizard.CombinedOutput()
	wizardStr := string(outWizard)
	if !strings.Contains(wizardStr, "欢迎使用 SnapVault") {
		t.Errorf("首次运行未触发欢迎向导: %s", wizardStr)
	}
	if !strings.Contains(wizardStr, "配置已成功保存") {
		t.Errorf("向导未成功保存配置: %s", wizardStr)
	}

	// 验证生成的 config.json
	cfgData, err := os.ReadFile(filepath.Join(wizardWorkingDir, "config.json"))
	if err != nil {
		t.Fatalf("未找到生成的 config.json: %v", err)
	}
	var savedCfg map[string]interface{}
	if err := json.Unmarshal(cfgData, &savedCfg); err != nil {
		t.Fatalf("解析 config.json 失败: %v", err)
	}
	if savedCfg["server"] != serverURL || savedCfg["key"] != testAPIKey {
		t.Errorf("生成的配置内容有误: %+v", savedCfg)
	}
	t.Log("✓ 场景 0 验证通过：首次引导交互、自动机器名与 config.json 持久化正确！")

	// ==========================================
	// 场景 1: 首次全量上传验证
	// ==========================================
	t.Log("\n[场景 1] 测试首次全量上传...")
	// 创建 3 张截图
	baseTime := time.Now().Unix() - 1000
	_ = generateTestImage(filepath.Join(clientScreenshotsDir, "shot1.png"), 400, 300, color.RGBA{255, 0, 0, 255}, baseTime+10)
	_ = generateTestImage(filepath.Join(clientScreenshotsDir, "shot2.png"), 400, 300, color.RGBA{0, 255, 0, 255}, baseTime+20)
	_ = generateTestImage(filepath.Join(clientScreenshotsDir, "shot3.png"), 400, 300, color.RGBA{0, 0, 255, 255}, baseTime+30)

	cmdSync1 := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", machineName,
		"-dir", clientScreenshotsDir,
	)
	cmdSync1.Env = append(os.Environ(), "CI=true")
	outSync1, err := cmdSync1.CombinedOutput()
	if err != nil {
		t.Fatalf("首次同步执行失败: %v, 输出: %s", err, string(outSync1))
	}
	if !strings.Contains(string(outSync1), "共完成 3 张截图上传") {
		t.Errorf("首次全量上传输出不符合预期: %s", string(outSync1))
	}
	t.Log("✓ 场景 1 验证通过：首次全量上传 3 张截图成功！")

	// ==========================================
	// 场景 2: 连续截图后运行，验证命中分支 B 快速追加 (Fast-Path)
	// ==========================================
	t.Log("\n[场景 2] 测试连续截图后命中分支 B (Fast-Path 快速追加)...")
	// 新增 2 张时间戳更大的截图
	_ = generateTestImage(filepath.Join(clientScreenshotsDir, "shot4.png"), 400, 300, color.RGBA{255, 255, 0, 255}, baseTime+40)
	_ = generateTestImage(filepath.Join(clientScreenshotsDir, "shot5.png"), 400, 300, color.RGBA{255, 0, 255, 255}, baseTime+50)

	cmdSync2 := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", machineName,
		"-dir", clientScreenshotsDir,
	)
	cmdSync2.Env = append(os.Environ(), "CI=true")
	outSync2, err := cmdSync2.CombinedOutput()
	if err != nil {
		t.Fatalf("Fast-Path 同步执行失败: %v, 输出: %s", err, string(outSync2))
	}
	syncStr2 := string(outSync2)
	if !strings.Contains(syncStr2, "命中 Fast-Path 快速追加机制") {
		t.Errorf("未命中分支 B 快速追加: %s", syncStr2)
	}
	if strings.Contains(syncStr2, "GET /api/manifest") {
		t.Errorf("分支 B 严禁拉取清单，但日志中出现了下载清单的行为！")
	}
	if !strings.Contains(syncStr2, "共完成 2 张截图上传") {
		t.Errorf("追加数量不符合预期: %s", syncStr2)
	}
	t.Log("✓ 场景 2 验证通过：精准命中分支 B 快速追加，且未拉取服务端 Manifest！")

	// ==========================================
	// 场景 3: 无新截图运行，验证命中分支 A 秒级跳过 (No-Op)
	// ==========================================
	t.Log("\n[场景 3] 测试无变更时命中分支 A (秒级跳过)...")
	cmdSync3 := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", machineName,
		"-dir", clientScreenshotsDir,
	)
	cmdSync3.Env = append(os.Environ(), "CI=true")
	t3Start := time.Now()
	outSync3, err := cmdSync3.CombinedOutput()
	t3Elapsed := time.Since(t3Start)
	if err != nil {
		t.Fatalf("分支 A 执行失败: %v, 输出: %s", err, string(outSync3))
	}
	syncStr3 := string(outSync3)
	if !strings.Contains(syncStr3, "全部截图已为最新状态") {
		t.Errorf("未命中分支 A 跳过逻辑: %s", syncStr3)
	}
	t.Logf("✓ 场景 3 验证通过：命中分支 A 秒级跳过 (总耗时: %v)！", t3Elapsed)

	// ==========================================
	// 场景 4: 本地删除截图后运行，验证命中分支 C 并正确删除服务端文件
	// ==========================================
	t.Log("\n[场景 4] 测试本地删除后命中分支 C，并在服务端同步软删除...")
	// 删除本地的 shot2.png
	_ = os.Remove(filepath.Join(clientScreenshotsDir, "shot2.png"))

	cmdSync4 := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", machineName,
		"-dir", clientScreenshotsDir,
	)
	cmdSync4.Env = append(os.Environ(), "CI=true")
	outSync4, err := cmdSync4.CombinedOutput()
	if err != nil {
		t.Fatalf("分支 C 同步执行失败: %v, 输出: %s", err, string(outSync4))
	}
	syncStr4 := string(outSync4)
	if !strings.Contains(syncStr4, "降级拉取服务端清单执行全量比对") {
		t.Errorf("删除后应降级命中分支 C: %s", syncStr4)
	}
	if !strings.Contains(syncStr4, "已从远端同步移除: shot2.jpg") {
		t.Errorf("未成功从服务端删除对应文件: %s", syncStr4)
	}

	// 确认服务端 Manifest 数量变为 4
	reqCheck, _ := http.NewRequest("POST", serverURL+"/api/check", strings.NewReader(fmt.Sprintf(`{"machine":"%s"}`, machineName)))
	reqCheck.Header.Set("Content-Type", "application/json")
	reqCheck.Header.Set("X-API-Key", testAPIKey)
	resCheck, err := http.DefaultClient.Do(reqCheck)
	if err != nil {
		t.Fatalf("请求 /api/check 失败: %v", err)
	}
	var checkData map[string]interface{}
	body, _ := io.ReadAll(resCheck.Body)
	_ = json.Unmarshal(body, &checkData)
	resCheck.Body.Close()
	if int(checkData["remoteCount"].(float64)) != 4 {
		t.Errorf("删除后远端有效数量应为 4，实际: %v", checkData["remoteCount"])
	}
	t.Log("✓ 场景 4 验证通过：分支 C 正常拉取清单，且精准同步删除了服务端对应截图！")

	// ==========================================
	// 场景 5: 模拟批量删除触发安全熔断 (Circuit Breaker)
	// ==========================================
	t.Log("\n[场景 5] 测试批量删除触发删除安全熔断门槛...")
	// 创建机器 test-pc-breaker，先上传 40 张截图
	breakerMachine := "pc-breaker"
	breakerDir := filepath.Join(baseDir, "breaker_shots")
	_ = os.MkdirAll(breakerDir, 0755)

	for i := 1; i <= 40; i++ {
		p := filepath.Join(breakerDir, fmt.Sprintf("burst_%03d.png", i))
		_ = generateTestImage(p, 100, 100, color.RGBA{100, 100, 100, 255}, baseTime+int64(i))
	}

	cmdBreakerInit := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", breakerMachine,
		"-dir", breakerDir,
		"-workers", "4",
	)
	cmdBreakerInit.Env = append(os.Environ(), "CI=true")
	if out, err := cmdBreakerInit.CombinedOutput(); err != nil {
		t.Fatalf("初始化熔断测试数据失败: %v, %s", err, string(out))
	}

	// 模拟删除了其中的 35 张 (35 / 40 = 87.5% > 20% 且 35 > 30)
	for i := 1; i <= 35; i++ {
		p := filepath.Join(breakerDir, fmt.Sprintf("burst_%03d.png", i))
		_ = os.Remove(p)
	}

	// 尝试运行，未带 -force-delete，应触发熔断报错
	cmdBreakerRun := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", breakerMachine,
		"-dir", breakerDir,
	)
	cmdBreakerRun.Env = append(os.Environ(), "CI=true")
	outBreaker, err := cmdBreakerRun.CombinedOutput()
	if err == nil {
		t.Fatalf("预期应触发安全熔断异常退出，但实际上成功了！输出: %s", string(outBreaker))
	}
	breakerStr := string(outBreaker)
	if !strings.Contains(breakerStr, "安全熔断警告") || !strings.Contains(breakerStr, "-force-delete") {
		t.Errorf("熔断警告提示不符合预期: %s", breakerStr)
	}

	// 验证带上 -force-delete 时可以继续执行
	cmdForceDelete := exec.Command(clientBin,
		"-server", serverURL,
		"-key", testAPIKey,
		"-machine", breakerMachine,
		"-dir", breakerDir,
		"-force-delete",
	)
	cmdForceDelete.Env = append(os.Environ(), "CI=true")
	outForce, err := cmdForceDelete.CombinedOutput()
	if err != nil {
		t.Fatalf("带 -force-delete 时执行失败: %v, 输出: %s", err, string(outForce))
	}
	if !strings.Contains(string(outForce), "已携带 -force-delete 参数，绕过熔断门槛继续执行同步删除") {
		t.Errorf("强制删除输出未包含确认提示: %s", string(outForce))
	}
	t.Log("✓ 场景 5 验证通过：安全熔断拦截机制工作完全正常，成功保护了云端数据！")

	// ==========================================
	// 场景 6: 服务端删除截图后运行，验证删除传播到本地回收站，不重传复活
	// ==========================================
	t.Log("\n[场景 6] 测试服务端删除后同步传播到本地回收站...")

	// 6a: 服务端删除最新的 shot5 (删除最新文件同时验证 Branch B 墓碑守卫)
	// 默认应优先移入系统回收站 (macOS 废纸篓 / Windows 回收站 / gio trash)
	if err := serverDeleteFile(serverURL, testAPIKey, machineName, "shot5.jpg"); err != nil {
		t.Fatalf("服务端删除 shot5 失败: %v", err)
	}
	out6a, err := runClient(clientBin, serverURL, testAPIKey, machineName, clientScreenshotsDir)
	if err != nil {
		t.Fatalf("服务端删除传播同步执行失败: %v, 输出: %s", err, out6a)
	}
	if !strings.Contains(out6a, "降级拉取服务端清单执行全量比对") {
		t.Errorf("存在更新墓碑时应降级命中分支 C 而非快速追加: %s", out6a)
	}
	if !strings.Contains(out6a, "已移入系统回收站") && !strings.Contains(out6a, "已移入本地回收站") {
		t.Errorf("shot5 应被移入系统回收站 (或环境不支持时回退本地回收站): %s", out6a)
	}
	if _, err := os.Stat(filepath.Join(clientScreenshotsDir, "shot5.png")); err == nil {
		t.Errorf("shot5.png 应已从截图目录移除")
	}
	for _, keep := range []string{"shot1.png", "shot3.png", "shot4.png"} {
		if _, err := os.Stat(filepath.Join(clientScreenshotsDir, keep)); err != nil {
			t.Errorf("未删除的 %s 不应被影响: %v", keep, err)
		}
	}
	if cnt, cerr := remoteCount(serverURL, testAPIKey, machineName); cerr != nil || cnt != 3 {
		t.Errorf("服务端删除传播后远端数量应保持 3 (未被复活重传)，实际: %d (err: %v)", cnt, cerr)
	}
	t.Log("✓ 场景 6a 验证通过：服务端删除传播至系统回收站，未发生幽灵文件复活重传！")

	// 6b: 新增 shot6 并上传后，在服务端删除并以剥离 PATH 的环境运行，
	// 验证系统回收站不可用时自动回退至 .snapvault-trash 文件夹
	_ = generateTestImage(filepath.Join(clientScreenshotsDir, "shot6.png"), 400, 300, color.RGBA{0, 255, 255, 255}, baseTime+60)
	out6bUp, err := runClient(clientBin, serverURL, testAPIKey, machineName, clientScreenshotsDir)
	if err != nil {
		t.Fatalf("shot6 上传同步执行失败: %v, 输出: %s", err, out6bUp)
	}
	if !strings.Contains(out6bUp, "共完成 1 张截图上传") {
		t.Errorf("shot6 应被增量上传: %s", out6bUp)
	}

	if err := serverDeleteFile(serverURL, testAPIKey, machineName, "shot6.jpg"); err != nil {
		t.Fatalf("服务端删除 shot6 失败: %v", err)
	}
	out6b, err := runClient(clientBin, serverURL, testAPIKey, machineName, clientScreenshotsDir, "PATH=/nonexistent")
	if err != nil {
		t.Fatalf("回退回收站同步执行失败: %v, 输出: %s", err, out6b)
	}
	if !strings.Contains(out6b, "已移入本地回收站") {
		t.Errorf("系统回收站不可用时应回退至本地回收站文件夹: %s", out6b)
	}
	if _, err := os.Stat(filepath.Join(clientScreenshotsDir, "shot6.png")); err == nil {
		t.Errorf("shot6.png 应已从截图目录移除")
	}
	trashed, _ := filepath.Glob(filepath.Join(clientScreenshotsDir, ".snapvault-trash", "*", "shot6.png"))
	if len(trashed) != 1 {
		t.Errorf("本地回收站文件夹中应存在恰好 1 份 shot6.png，实际: %v", trashed)
	}
	if cnt, cerr := remoteCount(serverURL, testAPIKey, machineName); cerr != nil || cnt != 3 {
		t.Errorf("回退删除后远端数量应保持 3，实际: %d (err: %v)", cnt, cerr)
	}
	t.Log("✓ 场景 6b 验证通过：系统回收站不可用时自动回退至 .snapvault-trash 本地回收站！")

	// ==========================================
	// 场景 7: 墓碑确认清理 — 验证服务端清单墓碑与回收站被永久清除
	// ==========================================
	t.Log("\n[场景 7] 测试墓碑确认后服务端清单与回收站永久清理...")

	// 服务端清单应只剩 3 个有效条目，且不存在任何墓碑
	reqManifest7, _ := http.NewRequest("GET", serverURL+fmt.Sprintf("/api/manifest?machine=%s", machineName), nil)
	reqManifest7.Header.Set("X-API-Key", testAPIKey)
	resManifest7, err := http.DefaultClient.Do(reqManifest7)
	if err != nil {
		t.Fatalf("请求 /api/manifest 失败: %v", err)
	}
	bodyManifest7, _ := io.ReadAll(resManifest7.Body)
	resManifest7.Body.Close()
	var manifest7 struct {
		Count int `json:"count"`
		Items map[string]struct {
			DeletedAt *int64 `json:"deletedAt"`
		} `json:"items"`
	}
	if err := json.Unmarshal(bodyManifest7, &manifest7); err != nil {
		t.Fatalf("解析清单失败: %v", err)
	}
	if manifest7.Count != 3 || len(manifest7.Items) != 3 {
		t.Errorf("清单应只剩 3 个有效条目 (count=%d, items=%d)", manifest7.Count, len(manifest7.Items))
	}
	for key, item := range manifest7.Items {
		if item.DeletedAt != nil {
			t.Errorf("墓碑 %s 应已被确认清除", key)
		}
	}

	// 服务端回收站应已被清空
	srvTrash, _ := filepath.Glob(filepath.Join(serverDataDir, "trash", machineName, "*", "*"))
	if len(srvTrash) != 0 {
		t.Errorf("服务端回收站应已清空，实际残留: %v", srvTrash)
	}

	// 墓碑清除后再次同步应命中分支 A (状态干净)
	out7, err := runClient(clientBin, serverURL, testAPIKey, machineName, clientScreenshotsDir)
	if err != nil {
		t.Fatalf("清理后同步执行失败: %v, 输出: %s", err, out7)
	}
	if !strings.Contains(out7, "全部截图已为最新状态") {
		t.Errorf("墓碑清除后应命中分支 A 秒级跳过: %s", out7)
	}
	t.Log("✓ 场景 7 验证通过：墓碑确认后服务端清单与回收站彻底清理，同步状态干净！")

	t.Log("\n🎉🎉🎉 系统级端到端 (E2E) 所有 8 大场景全部验证通过！闭环完成！")
}

package scan

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestToVirtualKey(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"2026-10-15-001.png", "2026-10-15-001.jpg"},
		{"screenshot.JPEG", "screenshot.jpg"},
		{"game.webp", "game.jpg"},
		{"normal.jpg", "normal.jpg"},
	}

	for _, c := range cases {
		out := ToVirtualKey(c.input)
		if out != c.expected {
			t.Errorf("ToVirtualKey(%s) = %s; 预期 %s", c.input, out, c.expected)
		}
	}
}

func TestScanDirectory(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "snapvault_scan_test_*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// 创建几个测试文件
	fileOld := filepath.Join(tempDir, "old.png")
	fileNew := filepath.Join(tempDir, "new.jpg")
	fileTxt := filepath.Join(tempDir, "notes.txt") // 非图片，应被忽略
	fileHidden := filepath.Join(tempDir, ".hidden.png") // 隐藏文件，应被忽略

	_ = os.WriteFile(fileOld, []byte("img-old"), 0644)
	_ = os.WriteFile(fileNew, []byte("img-new-content"), 0644)
	_ = os.WriteFile(fileTxt, []byte("hello"), 0644)
	_ = os.WriteFile(fileHidden, []byte("hidden"), 0644)

	// 修改时间戳，使其具有确定的大小顺序
	now := time.Now().Unix()
	_ = os.Chtimes(fileOld, time.Unix(now-100, 0), time.Unix(now-100, 0))
	_ = os.Chtimes(fileNew, time.Unix(now, 0), time.Unix(now, 0))

	result, err := ScanDirectory(tempDir)
	if err != nil {
		t.Fatalf("扫描目录失败: %v", err)
	}

	if result.Count != 2 {
		t.Fatalf("预期扫描出 2 个合法图片，实际: %d", result.Count)
	}

	if result.Files[0].Key != "old.jpg" {
		t.Errorf("预期排在首位的是较早的 old.jpg，实际: %s", result.Files[0].Key)
	}
	if result.Files[1].Key != "new.jpg" {
		t.Errorf("预期排在第二位的是较晚的 new.jpg，实际: %s", result.Files[1].Key)
	}

	if result.OldestMtime != now-100 {
		t.Errorf("预期 OldestMtime 为 %d，实际: %d", now-100, result.OldestMtime)
	}
	if result.LatestMtime != now {
		t.Errorf("预期 LatestMtime 为 %d，实际: %d", now, result.LatestMtime)
	}
}

//go:build darwin

package syncer

import (
	"fmt"
	"os/exec"
	"strings"
)

// trashToSystem 通过 Finder AppleScript 将文件移入 macOS 废纸篓
func trashToSystem(path string) error {
	if _, err := exec.LookPath("osascript"); err != nil {
		return fmt.Errorf("osascript 不可用: %w", err)
	}
	escaped := strings.ReplaceAll(path, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	script := fmt.Sprintf(`tell application "Finder" to delete POSIX file "%s"`, escaped)
	if out, err := exec.Command("osascript", "-e", script).CombinedOutput(); err != nil {
		return fmt.Errorf("osascript 失败: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

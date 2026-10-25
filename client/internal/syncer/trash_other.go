//go:build !darwin && !windows

package syncer

import (
	"fmt"
	"os/exec"
)

// trashToSystem 通过 gio trash (freedesktop 规范) 将文件移入系统回收站
func trashToSystem(path string) error {
	gioPath, err := exec.LookPath("gio")
	if err != nil {
		return fmt.Errorf("gio 不可用: %w", err)
	}
	if out, err := exec.Command(gioPath, "trash", path).CombinedOutput(); err != nil {
		return fmt.Errorf("gio trash 失败: %v (%s)", err, string(out))
	}
	return nil
}

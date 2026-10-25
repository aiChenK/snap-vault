//go:build windows

package syncer

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	foDelete     = 3    // FO_DELETE
	fofSilent    = 0x4  // 不显示进度对话框
	fofNoConfirm = 0x10 // 不弹确认框
	fofAllowUndo = 0x40 // 移入回收站而非永久删除
	fofNoErrorUI = 0x400
)

// shFileOpStructW 与 Win32 SHFILEOPSTRUCTW 内存布局对齐
type shFileOpStructW struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted bool
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

var (
	shell32              = syscall.NewLazyDLL("shell32.dll")
	procSHFileOperationW = shell32.NewProc("SHFileOperationW")
)

// trashToSystem 通过 SHFileOperationW (FOF_ALLOWUNDO) 将文件移入 Windows 回收站
func trashToSystem(path string) error {
	from, err := syscall.UTF16FromString(path)
	if err != nil {
		return fmt.Errorf("路径编码失败: %w", err)
	}
	// pFrom 要求双 \0 结尾
	from = append(from, 0)

	op := shFileOpStructW{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirm | fofSilent | fofNoErrorUI,
	}
	ret, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if ret != 0 {
		return fmt.Errorf("SHFileOperationW 返回错误码 %d", ret)
	}
	if op.fAnyOperationsAborted {
		return errors.New("系统回收站操作被中止")
	}
	return nil
}

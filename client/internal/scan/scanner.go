package scan

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// LocalFile 本地扫描出的截图文件元数据
type LocalFile struct {
	Key       string `json:"key"`        // 规范化后的虚拟 Key (统一 .jpg 结尾)
	OrigName  string `json:"orig_name"`  // 本地原始文件名
	OrigPath  string `json:"orig_path"`  // 本地绝对路径
	OrigSize  int64  `json:"orig_size"`  // 原始字节大小
	OrigMtime int64  `json:"orig_mtime"` // 修改时间 (Unix 秒级时间戳)
}

// ScanResult 本地扫描的聚合统计结果
type ScanResult struct {
	Files       []LocalFile `json:"files"`
	Count       int         `json:"count"`
	LatestMtime int64       `json:"latest_mtime"`
	OldestMtime int64       `json:"oldest_mtime"`
}

var supportedExtensions = map[string]bool{
	".png":  true,
	".jpg":  true,
	".jpeg": true,
	".webp": true,
	".gif":  true,
}

// ToVirtualKey 将本地文件名转为规范化的虚拟 Key (xxx.jpg)
func ToVirtualKey(fileName string) string {
	ext := filepath.Ext(fileName)
	base := strings.TrimSuffix(fileName, ext)
	return base + ".jpg"
}

// ScanDirectory 扫描指定目录，筛选截图并按 mtime 从小到大升序排序
func ScanDirectory(dirPath string) (*ScanResult, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, fmt.Errorf("读取目录失败: %w", err)
	}

	var files []LocalFile
	keyMap := make(map[string]bool)

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		// 忽略隐藏文件与临时文件
		if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~") {
			continue
		}

		ext := strings.ToLower(filepath.Ext(name))
		if !supportedExtensions[ext] {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		vKey := ToVirtualKey(name)
		// 如果有重名虚拟 Key（例如同一目录下既有 pic.png 又有 pic.jpg），只保留第一个
		if keyMap[vKey] {
			continue
		}
		keyMap[vKey] = true

		absPath := filepath.Join(dirPath, name)
		mtime := info.ModTime().Unix()

		files = append(files, LocalFile{
			Key:       vKey,
			OrigName:  name,
			OrigPath:  absPath,
			OrigSize:  info.Size(),
			OrigMtime: mtime,
		})
	}

	// 按 OrigMtime 升序排序 (最早的在前，最新的在后)
	sort.Slice(files, func(i, j int) bool {
		if files[i].OrigMtime == files[j].OrigMtime {
			return files[i].Key < files[j].Key
		}
		return files[i].OrigMtime < files[j].OrigMtime
	})

	count := len(files)
	var latestMtime int64 = 0
	var oldestMtime int64 = 0

	if count > 0 {
		oldestMtime = files[0].OrigMtime
		latestMtime = files[count-1].OrigMtime
	}

	return &ScanResult{
		Files:       files,
		Count:       count,
		LatestMtime: latestMtime,
		OldestMtime: oldestMtime,
	}, nil
}

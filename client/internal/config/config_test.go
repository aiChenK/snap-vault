package config

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"
)

func TestGenerateUniqueMachineName(t *testing.T) {
	name1 := GenerateUniqueMachineName()
	name2 := GenerateUniqueMachineName()

	if name1 == "" || name2 == "" {
		t.Fatalf("生成的机器名称不能为空")
	}

	if name1 == name2 {
		t.Fatalf("连续生成的两次机器名不应重复 (熵值碰撞): %s vs %s", name1, name2)
	}

	reg := regexp.MustCompile(`^[a-z0-9_-]+-[a-f0-9]{4}$`)
	if !reg.MatchString(name1) {
		t.Fatalf("机器名称格式不符合规范: %s", name1)
	}

	if strings.Contains(name1, " ") || strings.Contains(name1, ".") {
		t.Fatalf("机器名称不应包含非法符号: %s", name1)
	}
}

func TestConfigThumbLevelParsing(t *testing.T) {
	// 1. 测试未指定 thumb_level 时默认 high
	jsonNoThumb := `{"server":"http://127.0.0.1:3000","key":"test","machine":"pc-1","dir":"."}`
	var cfg1 Config
	cfg1.ThumbLevel = DefaultThumbLevel
	_ = json.Unmarshal([]byte(jsonNoThumb), &cfg1)
	if cfg1.ThumbLevel != "high" {
		t.Errorf("未指定 thumb_level 时应保持默认 high, 实际: %s", cfg1.ThumbLevel)
	}

	// 2. 测试显式指定 thumb_level: "ultra"
	jsonWithThumb := `{"server":"http://127.0.0.1:3000","key":"test","machine":"pc-1","dir":".","thumb_level":"ultra"}`
	var cfg2 Config
	cfg2.ThumbLevel = DefaultThumbLevel
	_ = json.Unmarshal([]byte(jsonWithThumb), &cfg2)
	if cfg2.ThumbLevel != "ultra" {
		t.Errorf("显式指定 thumb_level 应为 ultra, 实际: %s", cfg2.ThumbLevel)
	}

	// 3. 测试通过 thumb_quality 兼容解析
	jsonWithQuality := `{"server":"http://127.0.0.1:3000","key":"test","machine":"pc-1","dir":".","thumb_quality":"medium"}`
	var cfg3 Config
	cfg3.ThumbLevel = DefaultThumbLevel
	_ = json.Unmarshal([]byte(jsonWithQuality), &cfg3)
	var rawMap map[string]interface{}
	if err := json.Unmarshal([]byte(jsonWithQuality), &rawMap); err == nil {
		if _, hasLevel := rawMap["thumb_level"]; !hasLevel {
			if qVal, ok := rawMap["thumb_quality"]; ok && qVal != nil {
				cfg3.ThumbLevel = strings.TrimSpace(strings.ToLower(fmt.Sprintf("%v", qVal)))
			}
		}
	}
	if cfg3.ThumbLevel != "medium" {
		t.Errorf("兼容解析 thumb_quality 应为 medium, 实际: %s", cfg3.ThumbLevel)
	}
}

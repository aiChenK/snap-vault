package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client 封装服务端 HTTP 通信
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// CheckResponse POST /api/check 的响应结构体
type CheckResponse struct {
	Success                  bool   `json:"success"`
	Machine                  string `json:"machine"`
	RemoteCount              int    `json:"remoteCount"`
	RemoteLatestMtime        int64  `json:"remoteLatestMtime"`
	RemoteOldestMtime        int64  `json:"remoteOldestMtime"`
	RemoteDeletedLatestMtime int64  `json:"remoteDeletedLatestMtime"`
	Error                    string `json:"error,omitempty"`
}

// ManifestItem 清单条目
type ManifestItem struct {
	Key        string `json:"key"`
	OrigName   string `json:"origName"`
	OrigSize   int64  `json:"origSize"`
	OrigMtime  int64  `json:"origMtime"`
	Mtime      int64  `json:"mtime"`
	Size       int64  `json:"size"`
	ThumbSize  int64  `json:"thumbSize"`
	Path       string `json:"path"`
	ThumbPath  string `json:"thumbPath"`
	UploadedAt int64  `json:"uploadedAt"`
	DeletedAt  *int64 `json:"deletedAt"`
}

// ManifestResponse GET /api/manifest 的响应结构体
type ManifestResponse struct {
	Success     bool                    `json:"success"`
	Machine     string                  `json:"machine"`
	Count       int                     `json:"count"`
	LatestMtime int64                   `json:"latestMtime"`
	OldestMtime int64                   `json:"oldestMtime"`
	Items       map[string]ManifestItem `json:"items"`
	Error       string                  `json:"error,omitempty"`
}

// AckResponse POST /api/tombstones/ack 的响应结构体
type AckResponse struct {
	Success      bool   `json:"success"`
	Purged       int    `json:"purged"`
	TrashCleaned int    `json:"trashCleaned"`
	Error        string `json:"error,omitempty"`
}

// UploadParams 上传请求参数
type UploadParams struct {
	Machine   string
	Key       string
	OrigName  string
	OrigSize  int64
	OrigMtime int64
	FileData  []byte
	ThumbData []byte
}

// NewClient 创建客户端实例
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: 45 * time.Second,
		},
	}
}

func (c *Client) newRequest(method, endpoint string, body io.Reader) (*http.Request, error) {
	u := fmt.Sprintf("%s%s", c.BaseURL, endpoint)
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}
	return req, nil
}

// Check 轻量探测远程聚合状态
func (c *Client) Check(machine string) (*CheckResponse, error) {
	payload := map[string]string{"machine": machine}
	data, _ := json.Marshal(payload)

	req, err := c.newRequest("POST", "/api/check", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 /api/check 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("服务端返回异常状态码 %d: %s", resp.StatusCode, string(body))
	}

	var res CheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("解析探测响应失败: %w", err)
	}

	return &res, nil
}

// GetManifest 拉取全量清单 (供分支 C 对齐使用)
func (c *Client) GetManifest(machine string) (*ManifestResponse, error) {
	endpoint := fmt.Sprintf("/api/manifest?machine=%s", url.QueryEscape(machine))
	req, err := c.newRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 /api/manifest 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("服务端返回异常状态码 %d: %s", resp.StatusCode, string(body))
	}

	var res ManifestResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("解析清单响应失败: %w", err)
	}

	return &res, nil
}

// Upload 上传图片与缩略图
func (c *Client) Upload(params UploadParams) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	_ = writer.WriteField("machine", params.Machine)
	_ = writer.WriteField("key", params.Key)
	_ = writer.WriteField("origName", params.OrigName)
	_ = writer.WriteField("origSize", strconv.FormatInt(params.OrigSize, 10))
	_ = writer.WriteField("origMtime", strconv.FormatInt(params.OrigMtime, 10))

	// 主图文件部分
	filePart, err := writer.CreateFormFile("file", params.Key)
	if err != nil {
		return fmt.Errorf("创建文件表单字段失败: %w", err)
	}
	if _, err := filePart.Write(params.FileData); err != nil {
		return fmt.Errorf("写入文件流失败: %w", err)
	}

	// 缩略图文件部分
	if len(params.ThumbData) > 0 {
		thumbPart, err := writer.CreateFormFile("thumb", "thumb_"+params.Key)
		if err != nil {
			return fmt.Errorf("创建缩略图表单字段失败: %w", err)
		}
		if _, err := thumbPart.Write(params.ThumbData); err != nil {
			return fmt.Errorf("写入缩略图流失败: %w", err)
		}
	}

	if err := writer.Close(); err != nil {
		return fmt.Errorf("关闭 multipart 写入流失败: %w", err)
	}

	// 支持 1 次重试
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := c.newRequest("POST", "/api/upload", bytes.NewReader(body.Bytes()))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", writer.FormDataContentType())

		resp, err := c.HTTPClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			respBody, _ := io.ReadAll(resp.Body)
			lastErr = fmt.Errorf("上传失败 HTTP %d: %s", resp.StatusCode, string(respBody))
		} else {
			lastErr = err
		}
		time.Sleep(500 * time.Millisecond)
	}

	return lastErr
}

// Delete 删除远程截图
func (c *Client) Delete(machine, key string) error {
	payload := map[string]string{
		"machine": machine,
		"key":     key,
	}
	data, _ := json.Marshal(payload)

	req, err := c.newRequest("DELETE", "/api/file", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("请求 /api/file 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("删除失败 HTTP %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// AckTombstones 确认服务端墓碑已在本地同步删除，服务端将永久清除对应清单条目与回收站文件
func (c *Client) AckTombstones(machine string, keys []string) (*AckResponse, error) {
	payload := map[string]interface{}{
		"machine": machine,
		"keys":    keys,
	}
	data, _ := json.Marshal(payload)

	req, err := c.newRequest("POST", "/api/tombstones/ack", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 /api/tombstones/ack 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("墓碑确认失败 HTTP %d: %s", resp.StatusCode, string(body))
	}

	var res AckResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("解析墓碑确认响应失败: %w", err)
	}
	return &res, nil
}

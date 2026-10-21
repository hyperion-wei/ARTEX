package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
)

// 被动代理的入口策略管理：监听地址、代理认证、域名白名单。
//
// 作用范围只限于【被动实例】。Agent 走的是另一个固定监听（启动参数 -proxy 给的那个
// 地址），它的 guard 永远为空：不认证、不看白名单、全量记录。所以本页怎么改都不会
// 影响 Agent 原有的流量记录链路，也不会把凭据塞进 Chromium 不认的 --proxy-server。
// 两个实例共用同一份流量库，AI 用 traffic_search 查到的仍是全部经过本机代理的流量。

// ProxyGuardView 是配置页要看到的状态：Agent 侧（只读说明）+ 被动侧（可编辑）。
type ProxyGuardView struct {
	// Available = 本实例有没有跑代理（启动时 -proxy 为空则两者都没有）。
	Available bool `json:"available"`
	// AgentAddr / AgentProxyURL 是 Agent 用的内部代理地址，只读展示。
	AgentAddr     string `json:"agent_addr"`
	AgentProxyURL string `json:"agent_proxy_url"`
	// Enabled = 被动代理当前是否在监听；Listen 为空表示未启用。
	Enabled    bool     `json:"enabled"`
	Listen     string   `json:"listen"`
	User       string   `json:"user"`
	Pass       string   `json:"pass"`
	Allowlist  []string `json:"allowlist"`
	AuthOn     bool     `json:"auth_enabled"`
	ProxyURL   string   `json:"proxy_url"`
	CACertPath string   `json:"ca_cert_path"`
	CaptureOn  bool     `json:"capture_on"`
}

// splitProxyList 把 textarea 里的一行一条（或逗号/分号分隔）拆成条目。
func splitProxyList(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return r == '\n' || r == '\r' || r == ',' || r == ';'
	})
}

// applyProxyGuard 启动时把持久化的被动代理配置装回去。失败只记日志不阻断启动：
// 端口被别人占了就干脆不启用被动代理，Agent 侧的记录不受影响，不该因此拖垮整个平台。
func (m *Manager) applyProxyGuard() {
	if m.traffic == nil {
		return
	}
	user, _, _ := m.pg.GetSetting(settingProxyUser)
	pass, _, _ := m.pg.GetSetting(settingProxyPass)
	allow, _, _ := m.pg.GetSetting(settingProxyAllowlist)
	listen, _, _ := m.pg.GetSetting(settingProxyListen)
	if err := m.traffic.SetPassiveAuth(user, pass); err != nil {
		log.Printf("[traffic] 代理认证配置无效，本次按无认证处理：%v", err)
		_ = m.pg.SetSetting(settingProxyUser, "")
		_ = m.pg.SetSetting(settingProxyPass, "")
	}
	m.traffic.SetPassiveAllowlist(splitProxyList(allow))
	if strings.TrimSpace(listen) == "" {
		return // 没启用过就保持关闭，不凭空多开一个端口
	}
	if err := m.traffic.EnablePassive(listen); err != nil {
		log.Printf("[traffic] 被动代理 %s 起不来，本次不启用（Agent 流量仍正常记录）：%v", listen, err)
	}
}

// ProxyGuard 读当前状态。traffic 为 nil（未以 -proxy 启动）时只回 available=false。
func (m *Manager) ProxyGuard() ProxyGuardView {
	v := ProxyGuardView{Allowlist: []string{}, CaptureOn: m.TrafficEnabled()}
	if m.traffic == nil {
		return v
	}
	v.Available = true
	v.AgentAddr = m.traffic.InternalAddr()
	v.AgentProxyURL = m.traffic.ProxyAddr()
	v.CACertPath = m.traffic.CACertPath()
	listen, user, pass, allow, authOn := m.traffic.PassiveConfig()
	v.Listen, v.User, v.Pass, v.AuthOn = listen, user, pass, authOn
	if allow != nil {
		v.Allowlist = allow
	}
	v.Enabled = m.traffic.PassiveEnabled()
	v.ProxyURL = m.traffic.PassiveProxyAddr()
	return v
}

// SetProxyGuard 校验并应用新的入口策略，成功后才持久化。listen 传空 = 关闭被动代理。
//
// 顺序是有意的：认证与白名单只改 guard、不重启实例就能生效，先落库；起/挪地址可能
// 失败（端口被占、撞上别的服务），失败时作为错误返回，此时其余三项已生效也已保存。
func (m *Manager) SetProxyGuard(listen, user, pass, allowlist string) error {
	if m.traffic == nil {
		return errors.New("当前实例没有跑流量代理：启动时 -proxy 为空，被动代理不可用")
	}
	if err := m.traffic.SetPassiveAuth(user, pass); err != nil {
		return err
	}
	m.traffic.SetPassiveAllowlist(splitProxyList(allowlist))
	if err := m.pg.SetSetting(settingProxyUser, strings.TrimSpace(user)); err != nil {
		return err
	}
	if err := m.pg.SetSetting(settingProxyPass, strings.TrimSpace(pass)); err != nil {
		return err
	}
	if err := m.pg.SetSetting(settingProxyAllowlist, strings.Join(splitProxyList(allowlist), "\n")); err != nil {
		return err
	}
	listen = strings.TrimSpace(listen)
	if listen == "" {
		m.traffic.DisablePassive()
		return m.pg.SetSetting(settingProxyListen, "")
	}
	// 被动代理撞上平台自己的 API 端口是最伤的一种误配（代理会把 API 整个遮住）。
	// 启动阶段后端还没监听、光靠探测测不出来，所以拿 main 告知的自身地址单独挡一道。
	if m.selfListenOnPort(listen) {
		return fmt.Errorf("端口 %s 是 ARTEX 自己的服务端口，被动代理不能占用它（会把平台 API 遮住），换一个端口", listen)
	}
	if err := m.traffic.EnablePassive(listen); err != nil {
		return err
	}
	addr, _, _, _, _ := m.traffic.PassiveConfig()
	return m.pg.SetSetting(settingProxyListen, addr)
}

// SetSelfListen 告知本进程 HTTP 服务端的监听地址，并对已存在的冲突配置做一次自愈。
// 上一次运行如果把被动代理持久化成了同一个端口，本次启动时它已经压在 API 上了
// （Windows 允许这种并存），当场关掉比什么都安全。
func (m *Manager) SetSelfListen(addr string) {
	addr = strings.TrimSpace(addr)
	m.mu.Lock()
	m.selfListen = addr
	m.mu.Unlock()
	if m.traffic == nil || addr == "" {
		return
	}
	listen, _, _, _, _ := m.traffic.PassiveConfig()
	if !sameListenPort(listen, addr) {
		return
	}
	log.Printf("[traffic] 被动代理被配在平台自身端口 %s 上（会遮住自己的 API），已自动关闭；请在系统配置里换一个端口", listen)
	m.traffic.DisablePassive()
	_ = m.pg.SetSetting(settingProxyListen, "")
}

// selfListenOnPort 报告目标地址是否落在本进程 HTTP 服务端口上。
func (m *Manager) selfListenOnPort(addr string) bool {
	m.mu.RLock()
	self := m.selfListen
	m.mu.RUnlock()
	return self != "" && sameListenPort(addr, self)
}

// sameListenPort 只看端口号：两个监听只要端口相同就会互相干扰（不管 host 写法差异）。
func sameListenPort(a, b string) bool {
	pa, pb := listenPort(a), listenPort(b)
	return pa != "" && pa == pb
}

func listenPort(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	return port
}

// =====================================================================
// GET / POST /api/traffic/proxy
// =====================================================================

func (s *Server) getTrafficProxyConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.m.ProxyGuard())
}

func (s *Server) setTrafficProxyConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Listen    string   `json:"listen"`
		User      string   `json:"user"`
		Pass      string   `json:"pass"`
		Allowlist []string `json:"allowlist"`
		AllowText string   `json:"allow_text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	// 白名单同时接受数组和 textarea 原文，前端两种控件都能用。
	allowText := req.AllowText
	if allowText == "" && len(req.Allowlist) > 0 {
		allowText = strings.Join(req.Allowlist, "\n")
	}
	if err := s.m.SetProxyGuard(req.Listen, req.User, req.Pass, allowText); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	// 不需要重建 Agent：被动代理是独立实例，Agent 侧的地址与记录行为一点没变，
	// 这也是把它拆成两个端口的原因。
	writeJSON(w, 200, map[string]any{
		"ok":    true,
		"proxy": s.m.ProxyGuard(),
		"note":  "已生效。只影响被动代理这个端口；Agent 仍走内部代理，流量照常全量记录。",
	})
}

// GET /api/traffic/proxy/ca — 下载记录代理的根证书。
//
// 路径取自 traffic.CACertPath()（由数据目录拼出，不接受任何请求参数），所以不存在
// 路径穿越；给浏览器一个直链又不想多一套签名 URL 机制，不如让前端带 JWT 拉 blob。
func (s *Server) downloadTrafficProxyCA(w http.ResponseWriter, r *http.Request) {
	tr := s.m.Traffic()
	if tr == nil {
		writeErr(w, 503, "本实例没有跑流量代理（启动时 -proxy 为空），没有 CA 证书")
		return
	}
	pem, err := os.ReadFile(tr.CACertPath())
	if err != nil {
		// 证书由 go-mitmproxy 在代理启动时写出；文件不在说明这个实例的代理没成功起过。
		writeErr(w, 404, "CA 证书尚未生成（代理启动时写出）：确认流量代理已启动，或重启 artex 后重试")
		return
	}
	// 换一个好认的名字：库里那个 mitmproxy-ca-cert.pem 看不出是谁的证书。
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Length", fmt.Sprint(len(pem)))
	w.Header().Set("Content-Disposition", `attachment; filename="artex-mitm-ca.pem"`)
	_, _ = w.Write(pem)
}

package traffic

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// 被动代理：给人用的第二个监听实例。
//
// 为什么要单独一个实例，而不是在原来那个端口上加开关：Agent 和人的流量走的是同一个
// listener 时，代理层没有任何办法区分"这条请求来自 Agent 还是来自用户的浏览器"，
// 于是白名单会漏掉 Agent 该记的流量、密码会把 Agent 挡在 407 外。拆成两个端口之后，
// Agent 侧的 guard 恒为空（不认证、不看白名单、全量记录），这一侧的端口/密码/白名单
// 只约束用户自己指过来的流量。
//
// 两个实例共用同一个 sink，写同一份文件树与索引库，所以 AI 用 traffic_search 查的时候
// 不区分来源——它看到的就是"这段时间经过本机代理的全部目标流量"。

// proxyGuard 一份入口策略快照。
type proxyGuard struct {
	addr  string
	user  string
	pass  string
	allow []string // 归一化后的域名条目；空 = 全部拦截并记录
}

// authEnabled 报告是否要求代理认证。用户名与密码要么都配要么都不配
// （见 SetPassiveAuth），所以这里只需看是否非空。
func (g *proxyGuard) authEnabled() bool { return g != nil && (g.user != "" || g.pass != "") }

// guardAllows 报告该主机是否该被这个实例 MITM 拦截并记录。guard 为空或名单为空时
// 一律拦截——Agent 侧走的就是这条恒真分支。
func guardAllows(g *proxyGuard, host string) bool {
	if g == nil || len(g.allow) == 0 {
		return true
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, e := range g.allow {
		if host == e || strings.HasSuffix(host, "."+e) {
			return true
		}
	}
	return false
}

// mutateGuard 以 copy-on-write 方式更新一份快照。整体换指针而不是逐字段改，是为了让
// 正在处理请求的钩子看到的永远是一份自洽配置（改密码的同时不该出现「新用户名+旧密码」）。
func mutateGuard(p *atomic.Pointer[proxyGuard], fn func(*proxyGuard)) {
	cur := p.Load()
	next := proxyGuard{}
	if cur != nil {
		next = *cur
		next.allow = append([]string(nil), cur.allow...)
	}
	fn(&next)
	p.Store(&next)
}

// normalizeAllowEntry 把用户写的一行白名单条目收成纯主机名。
func normalizeAllowEntry(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "#") {
		return ""
	}
	// 允许写成 https://api.example.com/v1 这种顺手粘来的形式，取主机部分即可。
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimPrefix(s, "*.")
	s = strings.TrimPrefix(s, ".")
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	return strings.ToLower(strings.TrimSpace(s))
}

// InternalAddr 返回 Agent 侧代理的监听地址，供配置页说明"Agent 用的是哪个端口"。
func (t *Traffic) InternalAddr() string {
	t.addrMu.RLock()
	defer t.addrMu.RUnlock()
	return t.addr
}

// PassiveConfig 回读被动代理的当前状态。listen 为空表示未启用。
func (t *Traffic) PassiveConfig() (listen, user, pass string, allow []string, authOn bool) {
	g := t.passiveGuard.Load()
	if g == nil {
		return "", "", "", nil, false
	}
	return g.addr, g.user, g.pass, append([]string(nil), g.allow...), g.authEnabled()
}

// PassiveEnabled 报告被动代理是否正在监听。
func (t *Traffic) PassiveEnabled() bool {
	t.addrMu.RLock()
	defer t.addrMu.RUnlock()
	return t.passive != nil
}

// PassiveProxyAddr 是给人粘进浏览器/工具的地址：开了认证时嵌 user:pass。
// 只描述被动实例，与 Agent 侧的 ProxyAddr 互不相干。
func (t *Traffic) PassiveProxyAddr() string {
	g := t.passiveGuard.Load()
	if g == nil || g.addr == "" {
		return ""
	}
	hostport := g.addr
	if strings.HasPrefix(hostport, ":") {
		hostport = "127.0.0.1" + hostport
	}
	if g.authEnabled() {
		// url.UserPassword 负责转义口令里的 @ : / 等字符，否则地址会被解析错。
		return "http://" + url.UserPassword(g.user, g.pass).String() + "@" + hostport
	}
	return "http://" + hostport
}

// SetPassiveAuth 配置被动代理的入口认证（Proxy-Authorization: Basic）。两者都留空=关闭。
// 未启用被动代理时也可以先配好，下次 EnablePassive 时直接生效。
func (t *Traffic) SetPassiveAuth(user, pass string) error {
	user, pass = strings.TrimSpace(user), strings.TrimSpace(pass)
	if (user == "") != (pass == "") {
		return errors.New("代理认证需要同时给出用户名和密码，或两者都留空以关闭认证")
	}
	if user != "" && len(pass) < 6 {
		return fmt.Errorf("代理密码至少 6 位（当前 %d 位）：这个端口一旦被其它进程用上，弱口令等于开了个开放的出网代理", len(pass))
	}
	mutateGuard(&t.passiveGuard, func(g *proxyGuard) { g.user, g.pass = user, pass })
	return nil
}

// SetPassiveAllowlist 设置被动代理的域名白名单。空列表=经过的都记录。
// 条目 example.com 含其所有子域；也可写 api.example.com 只匹配该主机。
// 只作用于被动实例——Agent 的流量永远全量记录，不受这里影响。
func (t *Traffic) SetPassiveAllowlist(entries []string) {
	allow := make([]string, 0, len(entries))
	seen := map[string]bool{}
	for _, e := range entries {
		host := normalizeAllowEntry(e)
		if host == "" || seen[host] {
			continue
		}
		seen[host] = true
		allow = append(allow, host)
	}
	mutateGuard(&t.passiveGuard, func(g *proxyGuard) { g.allow = allow })
}

// EnablePassive 起（或挪到另一个地址）被动代理实例。地址为空 = 关闭。
//
// 换地址时先确认新地址可用、新实例启动无错，再关旧的：一旦新地址起不来而旧的已被
// 关掉，用户已经设好的浏览器代理会当场断掉，而这里没有任何"回滚"入口给他。
func (t *Traffic) EnablePassive(addr string) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		t.DisablePassive()
		return nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("监听地址应为 host:port 形式（如 127.0.0.1:8789）：%w", err)
	}
	if _, err := net.LookupPort("tcp", port); err != nil {
		return fmt.Errorf("端口 %q 无效：%w", port, err)
	}
	t.addrMu.Lock()
	defer t.addrMu.Unlock()
	if t.passive != nil {
		if g := t.passiveGuard.Load(); g != nil && g.addr == addr {
			return nil
		}
	}
	// 被动代理和 Agent 侧内部代理必须是两个端口，否则又回到"同一 listener 无法区分
	// 来源"的原点，白名单/密码会直接作用到 Agent 身上。
	if addr == t.addr {
		return fmt.Errorf("被动代理不能和 Agent 内部代理（%s）用同一个地址，请换一个端口", t.addr)
	}
	// 绑定成功不等于端口是空的：Windows 允许 127.0.0.1:8787 与一个已在监听 :8787 的
	// 服务并存（具体地址与通配地址不算冲突），代理起去就会把那个服务遮住。
	probe, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("地址 %s 无法监听（多半已被其它程序占用）：%w", addr, err)
	}
	_ = probe.Close()
	if httpServiceAlreadyOn(addr) {
		return fmt.Errorf("地址 %s 上已经有一个 HTTP 服务在应答，被动代理起上去会遮住它，请换一个端口", addr)
	}

	np, err := t.buildProxy(addr, &t.passiveGuard)
	if err != nil {
		return err
	}
	startErr := make(chan error, 1)
	go func() {
		if err := np.Start(); err != nil {
			startErr <- err
		}
	}()
	// go-mitmproxy 的 Start 只在失败时返回，正常服务时永久阻塞，所以短窗口内没有
	// 错误就是真起来了（预绑定已排除了最常见的占用失败）。
	select {
	case err := <-startErr:
		return fmt.Errorf("被动代理 %s 启动失败：%w", addr, err)
	case <-time.After(startupGrace):
	}

	// guard 里记下真正在听的地址，后面改密码/白名单都以它为基准回显。
	mutateGuard(&t.passiveGuard, func(g *proxyGuard) { g.addr = addr })
	old := t.passive
	t.passive = np
	if old != nil {
		_ = old.Close()
	}
	if host == "" || host == "0.0.0.0" {
		if _, _, _, _, authOn := t.PassiveConfig(); !authOn {
			log.Printf("[traffic] 警告：被动代理监听 %s 且未设密码，同网段可被任意使用", addr)
		}
	}
	log.Printf("[traffic] 被动代理已启用在 %s（Agent 仍走 %s，不受其白名单/密码影响）", addr, t.addr)
	return nil
}

// DisablePassive 关掉被动代理。Agent 侧的内部代理不受影响，继续记录。
func (t *Traffic) DisablePassive() {
	t.addrMu.Lock()
	old := t.passive
	t.passive = nil
	t.addrMu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	mutateGuard(&t.passiveGuard, func(g *proxyGuard) { g.addr = "" })
	log.Printf("[traffic] 被动代理已关闭；Agent 流量仍经 %s 全量记录", t.InternalAddr())
}

// startupGrace 是判定"新代理启动成功"的等待窗口。Start 失败是同步的（net.Listen
// 当场报错），给一个短缓冲就够，不宜让页面在保存按钮上卡太久。
const startupGrace = 400 * time.Millisecond

// httpServiceAlreadyOn 探测该地址上是否已经有一个会应答 HTTP 请求的服务。
// 连不上/被拒 = 端口空（返回 false）；拿到任何响应（含 4xx）= 有别的服务在跑。
//
// 回环的 IPv4 与 IPv6 要分别探：很多开发服务（如 next dev）只听 [::1] 而不在
// 127.0.0.1 上应答，只探一边会漏掉。
func httpServiceAlreadyOn(addr string) bool {
	port := portOf(addr)
	if port == "" {
		return false
	}
	for _, h := range []string{"127.0.0.1", "[::1]"} {
		if httpReply("http://" + h + ":" + port + "/") {
			return true
		}
	}
	return false
}

// httpReply 发一个不带代理、不复用连接的短探测请求，只要拿到任何响应就算有服务。
func httpReply(target string) bool {
	c := &http.Client{
		Timeout:   700 * time.Millisecond,
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true},
	}
	resp, err := c.Get(target)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return true
}

// portOf 从 host:port 里取端口号。
func portOf(addr string) string {
	_, p, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return ""
	}
	return p
}

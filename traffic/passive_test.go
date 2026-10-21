package traffic

import (
	"encoding/base64"
	"net/http"
	"testing"
)

// TestProxyBasicAuth 盯的是那个真实踩过的坑：net/http 的 req.BasicAuth() 只读
// Authorization，代理认证凭据按 RFC 7235 走 Proxy-Authorization，用错方法会让
// 所有带正确密码的客户端一律 407。
func TestProxyBasicAuth(t *testing.T) {
	newReq := func(headers map[string]string) *http.Request {
		r := &http.Request{Header: make(http.Header)}
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return r
	}
	basic := base64.StdEncoding.EncodeToString([]byte("probe:probepass1"))

	t.Run("从 Proxy-Authorization 读取", func(t *testing.T) {
		user, pass, ok := proxyBasicAuth(newReq(map[string]string{"Proxy-Authorization": "Basic " + basic}))
		if !ok || user != "probe" || pass != "probepass1" {
			t.Fatalf("got user=%q pass=%q ok=%v", user, pass, ok)
		}
	})
	t.Run("缺凭据头", func(t *testing.T) {
		if _, _, ok := proxyBasicAuth(newReq(nil)); ok {
			t.Fatal("无凭据头不应通过")
		}
	})
	t.Run("非 Basic 方案", func(t *testing.T) {
		if _, _, ok := proxyBasicAuth(newReq(map[string]string{"Proxy-Authorization": "Digest " + basic})); ok {
			t.Fatal("Digest 不该被当成 Basic 解析")
		}
	})
	t.Run("base64 非法", func(t *testing.T) {
		if _, _, ok := proxyBasicAuth(newReq(map[string]string{"Proxy-Authorization": "Basic @@@not-base64@@@"})); ok {
			t.Fatal("坏 base64 不应通过")
		}
	})
	t.Run("解码后无冒号", func(t *testing.T) {
		noSep := base64.StdEncoding.EncodeToString([]byte("probepass1"))
		if _, _, ok := proxyBasicAuth(newReq(map[string]string{"Proxy-Authorization": "Basic " + noSep})); ok {
			t.Fatal("user:pass 缺分隔符不应通过")
		}
	})
	t.Run("口令里带冒号", func(t *testing.T) {
		raw := base64.StdEncoding.EncodeToString([]byte("probe:a:b:c"))
		user, pass, ok := proxyBasicAuth(newReq(map[string]string{"Proxy-Authorization": "Basic " + raw}))
		if !ok || user != "probe" || pass != "a:b:c" {
			t.Fatalf("只应在第一个冒号处切分，got user=%q pass=%q ok=%v", user, pass, ok)
		}
	})
	t.Run("兼容 Authorization", func(t *testing.T) {
		if _, _, ok := proxyBasicAuth(newReq(map[string]string{"Authorization": "Basic " + basic})); !ok {
			t.Fatal("少数客户端把凭据放 Authorization，应兼容")
		}
	})
}

func TestNormalizeAllowEntry(t *testing.T) {
	cases := map[string]string{
		"example.com":                 "example.com",
		"  Example.COM  ":             "example.com",
		"*.example.com":               "example.com",
		".example.com":                "example.com",
		"https://api.example.com/v1 ": "api.example.com",
		"example.com:8443":            "example.com",
		"# 注释":                        "",
		"":                            "",
	}
	for in, want := range cases {
		if got := normalizeAllowEntry(in); got != want {
			t.Errorf("normalizeAllowEntry(%q)=%q want %q", in, got, want)
		}
	}
}

// TestGuardAllows 覆盖白名单语义：guard 为空或名单为空 = 全部记录；条目含其子域；
// 不匹配同名后缀。Agent 侧走的就是“空 guard → 恒真”这条分支。
func TestGuardAllows(t *testing.T) {
	if !guardAllows(nil, "anything.test") {
		t.Fatal("nil guard 应放行（Agent 侧就是这个状态）")
	}
	if !guardAllows(&proxyGuard{}, "anything.test") {
		t.Fatal("空白名单应放行所有主机（保持旧行为）")
	}
	g := &proxyGuard{allow: []string{"example.com", "other.cn", "api.only.test"}}
	for host, want := range map[string]bool{
		"example.com":        true,
		"api.example.com":    true,  // 条目含子域
		"deep.a.example.com": true,  // 多级子域
		"notexample.com":     false, // 不能被后缀匹配误伤
		"example.com.evil":   false, // 反向也不能
		"other.cn":           true,
		"x.other.cn":         true,
		"api.only.test":      true,
		"only.test":          false, // 精确条目不放宽到子域
		"unrelated.io":       false,
	} {
		if got := guardAllows(g, host); got != want {
			t.Errorf("guardAllows(%q)=%v want %v", host, got, want)
		}
	}
}

// TestPassiveConfigIsolatedFromAgent 钉住用户明确要求的那条不变量：被动代理的
// 白名单与密码不得影响 Agent 侧（内部实例）的记录行为。
func TestPassiveConfigIsolatedFromAgent(t *testing.T) {
	tr := &Traffic{addr: "127.0.0.1:8788"}
	tr.guard.Store(&proxyGuard{addr: "127.0.0.1:8788"})

	if err := tr.SetPassiveAuth("probe", "probepass1"); err != nil {
		t.Fatal(err)
	}
	tr.SetPassiveAllowlist([]string{"example.com"})

	// Agent 侧：白名单恒空、认证恒关 → 任意域名都要被拦截并记录。
	if g := tr.guard.Load(); g == nil || len(g.allow) != 0 || g.authEnabled() {
		t.Fatalf("Agent 侧 guard 被被动配置污染了：%+v", g)
	}
	for _, host := range []string{"unrelated.io", "example.com", "api.internal.test"} {
		if !guardAllows(tr.guard.Load(), host) {
			t.Errorf("Agent 侧不应看白名单，但 %q 被拦了", host)
		}
	}
	// ProxyAddr 不带凭据：Chromium 的 --proxy-server 不认内嵌 user:pass，
	// 而且 Agent 本来就不该被密码挡住。
	if got := tr.ProxyAddr(); got != "http://127.0.0.1:8788" {
		t.Errorf("ProxyAddr 不该被被动代理的密码影响：%q", got)
	}

	// 被动侧：配置先存着（未启用时 listen 为空，但密码/白名单保留，下次启用直接生效），
	// 且与内部地址相同时会被拒启用。
	listen, user, pass, allow, authOn := tr.PassiveConfig()
	if listen != "" || !authOn || user != "probe" || pass != "probepass1" || len(allow) != 1 {
		t.Errorf("被动侧配置回显不对：listen=%q auth=%v user=%q allow=%v", listen, authOn, user, allow)
	}
	if err := tr.EnablePassive("127.0.0.1:8788"); err == nil {
		t.Error("被动代理与 Agent 内部代理同地址应当被拒（否则又回到无法区分来源的原点）")
	}
	if tr.PassiveEnabled() {
		t.Error("被拒后不应处于已启用状态")
	}
	if err := tr.EnablePassive("not-an-address"); err == nil {
		t.Error("非法监听地址应报错")
	}
}

// TestPassiveAuthValidation 确认用户名/密码必须成对：半开状态会让代理变成一个
// 谁也连不上的死端口。
func TestPassiveAuthValidation(t *testing.T) {
	tr := &Traffic{addr: "127.0.0.1:8788"}
	tr.guard.Store(&proxyGuard{})
	if err := tr.SetPassiveAuth("probe", ""); err == nil {
		t.Error("只给用户名不给密码应当被拒")
	}
	if err := tr.SetPassiveAuth("probe", "short"); err == nil {
		t.Error("短口令应当被拒")
	}
	if err := tr.SetPassiveAuth("", ""); err != nil {
		t.Errorf("两者都空=关闭认证，不该报错：%v", err)
	}
	if _, _, _, _, authOn := tr.PassiveConfig(); authOn {
		t.Error("清空后认证应当已关闭")
	}
}

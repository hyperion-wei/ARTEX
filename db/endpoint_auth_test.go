package db

import (
	"strings"
	"testing"
)

// TestEndpointAuthRoundTrip 覆盖鉴权档案的写入、回读、推导位、JOIN 带出的接口信息、
// 枚举校验、待办清单与删除。用一条本测试专属的资产，不碰开发库里的真实数据。
func TestEndpointAuthRoundTrip(t *testing.T) {
	d, err := Open(testDSN(t))
	if err != nil {
		t.Skipf("postgres unavailable (%v) — skipping", err)
	}
	// 用 t.Cleanup 而不是 defer：Cleanups 是后注册先执行，所以先把 Close 登记上，
	// 下面再登记删除——删除会跑在 Close 之前。写成 defer 的话池先关，
	// 清理语句全部打在已关闭的连接上，错误又被下划线吞掉，只留下脏数据。
	t.Cleanup(func() { _ = d.Close() })
	as := d.Assets()

	const probeHost = "endpoint-auth-probe.example.invalid"
	id, err := as.UpsertEndpoint(UpsertEndpointReq{URL: "http://" + probeHost + "/api/p", Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := d.Exec(`DELETE FROM endpoint_auth WHERE asset_id=$1`, id); err != nil {
			t.Errorf("清理鉴权档案失败：%v", err)
		}
		if _, err := d.Exec(`DELETE FROM assets WHERE id=$1`, id); err != nil {
			t.Errorf("清理探针资产失败：%v", err)
		}
		// UpsertEndpoint 会按 URL 派生根域名/子域名，一并收掉。
		if _, err := d.Exec(`DELETE FROM assets WHERE domain IN ($1, $2)`, probeHost, "example.invalid"); err != nil {
			t.Errorf("清理派生资产失败：%v", err)
		}
	})

	if got, err := as.GetEndpointAuth(id); err != nil || got != nil {
		t.Fatalf("新资产不该已有档案：got=%+v err=%v", got, err)
	}

	// 给了凭据却没勾 has_credential：服务端要推导出来，否则档案自相矛盾，
	// 页面上的「缺凭据」筛选也会漏掉它。
	if err := as.UpsertEndpointAuth(&EndpointAuth{
		AssetID:    id,
		NeedsAuth:  true,
		AuthKind:   "bearer",
		Fields:     []EndpointAuthField{{Name: "Authorization", Where: "header", Kind: "bearer"}},
		Credential: EndpointAuthCredential{Headers: map[string]string{"Authorization": "Bearer probe-token"}},
		Source:     "ai",
		Confidence: 0.7,
		Note:       "探针写入",
		UpdatedBy:  "worker-1",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := as.GetEndpointAuth(id)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("档案没写进去")
	}
	if !got.HasCredential {
		t.Error("有凭据时 has_credential 应被推导为 true")
	}
	if len(got.Fields) != 1 || got.Fields[0].Name != "Authorization" || got.Fields[0].Where != "header" {
		t.Errorf("fields 往返不一致：%+v", got.Fields)
	}
	if got.Credential.Headers["Authorization"] != "Bearer probe-token" {
		t.Errorf("credential 往返不一致：%+v", got.Credential)
	}
	if !strings.Contains(got.URL, probeHost) || got.Method != "GET" {
		t.Errorf("JOIN 资产信息不对：url=%q method=%q", got.URL, got.Method)
	}
	if got.Source != "ai" || got.UpdatedBy != "worker-1" {
		t.Errorf("来源/署名没存住：source=%q updated_by=%q", got.Source, got.UpdatedBy)
	}

	// 非法枚举要在进 SQL 之前就被拒，别让用户看到一句 CHECK 约束报错。
	if err := as.UpsertEndpointAuth(&EndpointAuth{AssetID: id, AuthKind: "magic"}); err == nil {
		t.Error("非法 auth_kind 应被拒")
	}
	if err := as.UpsertEndpointAuth(&EndpointAuth{AssetID: id, Source: "alien"}); err == nil {
		t.Error("非法 source 应被拒")
	}
	if err := as.UpsertEndpointAuth(&EndpointAuth{AssetID: 1 << 40}); err == nil {
		t.Error("指向不存在资产的孤儿档案应被拒")
	}

	// 免鉴权的接口谈不上「已验证凭据」。
	if err := as.UpsertEndpointAuth(&EndpointAuth{AssetID: id, NeedsAuth: false, AuthKind: "none", Verified: true}); err != nil {
		t.Fatal(err)
	}
	got, err = as.GetEndpointAuth(id)
	if err != nil || got == nil {
		t.Fatalf("回读失败：%v", err)
	}
	if got.Verified {
		t.Error("needs_auth=false 时 verified 应被收敛为 false")
	}
	if got.HasCredential {
		t.Error("覆盖时未给凭据，has_credential 应回到 false")
	}

	// 待办清单：needs_auth 且无凭据的那条要被列出来。
	if err := as.UpsertEndpointAuth(&EndpointAuth{AssetID: id, NeedsAuth: true, AuthKind: "session"}); err != nil {
		t.Fatal(err)
	}
	missing, err := as.ListMissingEndpointAuth(500)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range missing {
		if m.AssetID == id {
			found = true
		}
	}
	if !found {
		t.Error("缺凭据的接口应出现在待办清单里")
	}

	byID, err := as.ListEndpointAuthByAssetIDs([]int64{id, 1 << 40})
	if err != nil {
		t.Fatal(err)
	}
	if len(byID) != 1 || byID[id] == nil {
		t.Errorf("批量读取结果不对（应只含存在的那条）：%+v", byID)
	}
	if empty, err := as.ListEndpointAuthByAssetIDs(nil); err != nil || len(empty) != 0 {
		t.Errorf("空 id 列表应直接返回空：%d %v", len(empty), err)
	}

	if err := as.DeleteEndpointAuth(id); err != nil {
		t.Fatal(err)
	}
	if got, _ := as.GetEndpointAuth(id); got != nil {
		t.Error("删除后仍能读到档案")
	}
}

package agent

import (
	"context"
	"encoding/json"

	actool "github.com/Autumn-27/norma/tool"

	"github.com/Autumn-27/artex/db"
)

// 接口鉴权档案工具：让执行者把「这个接口要不要鉴权、鉴权信息藏在哪个字段、
// 我们手上有没有可用凭据」结构化写回 endpoint_auth 表，而不是只留在文字结论里。
//
// 为什么单独成表而不是塞进资产的 auth 字段：auth 是资产表上的 jsonb 数组，只记
// 「看到过什么」，没法回答「还缺什么」——而后者正是规划下一步和页面上待办清单的依据。

// recordEndpointAuth 写入/覆盖一条鉴权档案。来源固定标成 ai：模型不能自称人工登记。
func (t *ToolSet) recordEndpointAuth() actool.CoreTool {
	return writeTool(
		"record_endpoint_auth",
		"登记/更新一个接口(或站点)资产的【鉴权档案】：是否需要鉴权、鉴权类型、鉴权字段藏在哪儿、手上有没有可用凭据。\n"+
			"怎么判断：\n"+
			"  · 响应 401/403、返回「未登录/无权限」文案、或跳转登录页 → needs_auth=true。\n"+
			"  · 请求里携带、且去掉后接口就拒绝的那个字段就是鉴权字段，填进 fields：where 取 header/query/body/cookie。常见 Authorization→bearer、Cookie 里的 sessionid/JSESSIONID/PHPSESSID→cookie|session、显式 token/key/apikey 参数→api_key、带 sign+timestamp+nonce→signature、用户名口令表单→basic。\n"+
			"  · 公开可读的接口(健康检查、静态资源、无需登录的列表)也要登记，needs_auth=false——「确认不需要」本身就是有用结论，auth_kind 填 none。\n"+
			"  · 已拿到能直接复放的凭据(token/cookie/账密)就填 credential 并把 has_credential 置 true；只有真的用它请求成功过才把 verified 置 true，没验证过就留 false。\n"+
			"⚠️只写你在流量或响应里【真实看到】的字段与值，不要猜测凭据内容；credential 会明文入库并在资产页面展示。asset_id 必须是已存在的资产。",
		obj(map[string]any{
			"asset_id":       intp("接口/站点资产的 id（list_assets 返回的 id，必填）"),
			"needs_auth":     map[string]any{"type": "boolean", "description": "该接口是否需要鉴权才能正常访问（必填）"},
			"auth_kind":      map[string]any{"type": "string", "enum": []string{"none", "basic", "bearer", "jwt", "api_key", "cookie", "session", "signature", "oauth", "unknown"}, "description": "鉴权类型；判断不出填 unknown"},
			"has_credential": map[string]any{"type": "boolean", "description": "是否已经拿到可用的鉴权信息；填了 credential 会自动按true处理"},
			"verified":       map[string]any{"type": "boolean", "description": "该凭据是否已被实际请求验证过可用（成功复放过才算）"},
			"fields": map[string]any{
				"type":        "array",
				"description": "识别出的鉴权字段列表：[{name,where,kind}]，where 取 header/query/body/cookie",
				"items":       obj(map[string]any{"name": str("字段名，如 Authorization / token / PHPSESSID"), "where": str("出现位置：header|query|body|cookie"), "kind": str("该字段的鉴权类型（可选）")}),
			},
			"credential": obj(map[string]any{
				"headers": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "请求头键值，如 {\"Authorization\":\"Bearer xxx\"}"},
				"cookies": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "Cookie 键值"},
				"params":  map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "URL/表单参数键值，如 token、appid"},
				"account": obj(map[string]any{"username": str("账号"), "password": str("口令")}, "username"),
				"raw":     str("整段凭据原文（不便拆成键值时用它，如完整 Cookie 串）"),
			}),
			"confidence": map[string]any{"type": "number", "description": "0-1，你对本条判断的把握；据现象推断而非直接看到时给低一点"},
			"note":       str("补充说明：怎么判断出来的、凭据从哪条流量拿到、有什么限制（如需 30 分钟内有效）"),
		}, "asset_id", "needs_auth"),
		func(_ context.Context, in json.RawMessage) (actool.Result, error) {
			if t.as == nil {
				return actool.Errorf("资产存储不可用，无法登记鉴权档案"), nil
			}
			var a db.EndpointAuth
			if err := json.Unmarshal(in, &a); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			if a.AssetID <= 0 {
				return actool.Errorf("asset_id 必填，且必须是 list_assets 返回的资产 id"), nil
			}
			// 来源与署名由程序判定，不接受模型自填：档案要能区分是谁写的。
			a.Source = "ai"
			a.UpdatedBy = t.worker
			if a.UpdatedBy == "" {
				a.UpdatedBy = "ai"
			}
			if err := t.as.UpsertEndpointAuth(&a); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			// 回读一次：has_credential 这类由服务端推导的位，模型要看到最终值才知道写没写进去。
			out, err := t.as.GetEndpointAuth(a.AssetID)
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			return jsonResult(out)
		})
}

// listEndpointAuth 读回鉴权档案。missing=true 时给「要鉴权但还没凭据」的待办清单，
// 是规划者挑下一步目标的一条现成线索。
func (t *ToolSet) listEndpointAuth() actool.CoreTool {
	return readTool(
		"list_endpoint_auth",
		"查接口资产的【鉴权档案】。两种用法：给 asset_ids 看指定接口的鉴权情况；给 missing=true 拿「需要鉴权但还没拿到凭据」的清单（规划下一步该去搞哪个接口的登录态）。\n"+
			"返回每条含 asset_id/url/method/needs_auth/auth_kind/has_credential/verified/fields/note。",
		obj(map[string]any{
			"asset_ids": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "要查的资产 id 列表"},
			"missing":   map[string]any{"type": "boolean", "description": "true=只列「要鉴权但缺凭据」的接口"},
			"limit":     intp("missing 模式最多返回多少条，默认 50"),
		}),
		func(_ context.Context, in json.RawMessage) (actool.Result, error) {
			if t.as == nil {
				return actool.Errorf("资产存储不可用，无法读取鉴权档案"), nil
			}
			var a struct {
				AssetIDs []int64 `json:"asset_ids"`
				Missing  bool    `json:"missing"`
				Limit    int     `json:"limit"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return actool.Errorf(err.Error()), nil
			}
			if a.Missing {
				items, err := t.as.ListMissingEndpointAuth(a.Limit)
				if err != nil {
					return actool.Errorf(err.Error()), nil
				}
				if items == nil {
					items = []*db.EndpointAuth{}
				}
				return jsonResult(map[string]any{"items": items, "count": len(items)})
			}
			if len(a.AssetIDs) == 0 {
				return actool.Errorf("需要 asset_ids，或 missing=true"), nil
			}
			byID, err := t.as.ListEndpointAuthByAssetIDs(a.AssetIDs)
			if err != nil {
				return actool.Errorf(err.Error()), nil
			}
			items := make([]*db.EndpointAuth, 0, len(byID))
			for _, id := range a.AssetIDs {
				if rec, ok := byID[id]; ok {
					items = append(items, rec)
				}
			}
			return jsonResult(map[string]any{"items": items, "count": len(items)})
		})
}

package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/Autumn-27/artex/agent"
	"github.com/Autumn-27/artex/db"
	actool "github.com/Autumn-27/norma/tool"
)

func (s *Server) mcpExportRegistry(token *db.MCPAccessToken) (map[string]actool.CoreTool, []mcpExportToolInfo, error) {
	if s.m.pg == nil {
		return nil, nil, errors.New("管理后台数据源(PostgreSQL)未连接")
	}
	raw := append(s.orchestrationTools(), s.platformTools()...)
	domain := buildDomainReg(s.m.Assets())
	for _, key := range mcpExportDomainToolKeys {
		if tool, ok := domain[key]; ok {
			raw = append(raw, tool)
		}
	}
	rows, err := s.m.pg.ListTools()
	if err != nil {
		return nil, nil, err
	}
	rowsByKey := make(map[string]*db.Tool, len(rows))
	for _, row := range rows {
		rowsByKey[row.Key] = row
	}
	var tokenAllowed map[string]bool
	if token != nil {
		tokenAllowed = make(map[string]bool, len(token.Tools))
		for _, key := range token.Tools {
			tokenAllowed[key] = true
		}
	}
	out := map[string]actool.CoreTool{}
	infos := []mcpExportToolInfo{}
	for _, base := range raw {
		key := base.Name()
		row := rowsByKey[key]
		if row == nil || !row.Enabled || !contains(row.Agents, "auto") {
			continue
		}
		if tokenAllowed != nil && !tokenAllowed[key] {
			continue
		}
		if _, exists := out[key]; exists {
			continue
		}
		var schema map[string]any
		if len(row.Schema) > 0 {
			_ = json.Unmarshal(row.Schema, &schema)
		}
		tool := agent.DecorateTool(base, row.Description, schema)
		if token != nil {
			tool = meterTool(tool, s.m.pg, key, "external_mcp", agent.RunInfo{SessionID: fmt.Sprintf("mcp-token-%d", token.ID)})
		}
		out[key] = tool
		infos = append(infos, mcpExportToolInfo{
			Name: key, Description: tool.Description(), ReadOnly: tool.IsReadOnly(nil),
			DefaultSelected: !mcpDangerousExportTools[key], Dangerous: mcpDangerousExportTools[key],
		})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].Name < infos[j].Name })
	return out, infos, nil
}

func mcpDefaultToolSelection(infos []mcpExportToolInfo) []string {
	out := []string{}
	for _, info := range infos {
		if info.DefaultSelected {
			out = append(out, info.Name)
		}
	}
	return out
}

func mcpValidateToolSelection(input []string, infos []mcpExportToolInfo) ([]string, error) {
	available := make(map[string]bool, len(infos))
	for _, info := range infos {
		available[info.Name] = true
	}
	seen := map[string]bool{}
	out := []string{}
	for _, name := range input {
		if name == "" || seen[name] {
			continue
		}
		if !available[name] {
			return nil, fmt.Errorf("工具不可用或已不再绑定 Auto：%s", name)
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

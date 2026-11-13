"use client";

import * as React from "react";

import {
  AlertTriangleIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { CopyButton } from "@/components/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { MCPAccessToken, MCPAccessTool } from "@/lib/types";

type CreatedToken = {
  secret: string;
  name: string;
};

function mcpEndpoint() {
  if (process.env.NEXT_PUBLIC_MCP_URL) return process.env.NEXT_PUBLIC_MCP_URL;
  const base =
    process.env.NODE_ENV !== "production"
      ? `${window.location.protocol}//${window.location.hostname}:8787`
      : window.location.origin;
  return `${base}/mcp`;
}

export function MCPAccessPanel() {
  const [tokens, setTokens] = React.useState<MCPAccessToken[]>([]);
  const [tools, setTools] = React.useState<MCPAccessTool[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [created, setCreated] = React.useState<CreatedToken | null>(null);
  const [editing, setEditing] = React.useState<MCPAccessToken | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editTools, setEditTools] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [tokenList, catalog] = await Promise.all([api.mcpAccessTokens(), api.mcpAccessTools()]);
      setTokens(tokenList);
      setTools(catalog.tools ?? []);
    } catch (error) {
      toast.error(`加载对外开放配置失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function createToken() {
    setCreating(true);
    try {
      const result = await api.createMCPAccessToken();
      setCreated({ secret: result.token, name: result.access_token.name });
      await load();
    } catch (error) {
      toast.error(`创建 Token 失败：${(error as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  function openEdit(token: MCPAccessToken) {
    setEditing(token);
    setEditName(token.name);
    setEditTools(token.tools);
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editName.trim()) {
      toast.error("请填写 Token 名称");
      return;
    }
    setSaving(true);
    try {
      await api.updateMCPAccessToken(editing.id, { name: editName.trim(), tools: editTools });
      toast.success("Token 授权已更新");
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(`保存失败：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleToken(token: MCPAccessToken) {
    setBusyId(token.id);
    try {
      await api.updateMCPAccessToken(token.id, { enabled: !token.enabled });
      setTokens((current) =>
        current.map((item) => (item.id === token.id ? { ...item, enabled: !item.enabled } : item)),
      );
      toast.success(token.enabled ? "Token 已停用" : "Token 已启用");
    } catch (error) {
      toast.error(`操作失败：${(error as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function removeToken(token: MCPAccessToken) {
    setBusyId(token.id);
    try {
      await api.deleteMCPAccessToken(token.id);
      setTokens((current) => current.filter((item) => item.id !== token.id));
      toast.success("Token 已删除");
    } catch (error) {
      toast.error(`删除失败：${(error as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  const config = created
    ? JSON.stringify(
        {
          mcpServers: {
            artex: {
              type: "http",
              url: mcpEndpoint(),
              headers: { Authorization: `Bearer ${created.secret}` },
            },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-primary/20 bg-linear-to-br from-primary/5 via-card to-card">
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <ShieldCheckIcon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle>让其他 Agent 操作 ARTEX</CardTitle>
              <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
                通过 Streamable HTTP MCP 暴露 Auto 的领域与任务编排工具。每个 Token 独立授权，明文只在创建时显示一次。
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCwIcon className={loading ? "animate-spin" : ""} /> 刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void createToken()} disabled={creating || loading}>
            <PlusIcon /> {creating ? "创建中…" : "一键创建 Token"}
          </Button>
          <span className="text-muted-foreground text-xs">
            默认排除 Skill、MCP、自定义工具管理及资产删除等高风险操作。
          </span>
        </CardContent>
      </Card>

      {tokens.length === 0 && !loading ? (
        <button
          type="button"
          onClick={() => void createToken()}
          className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-foreground/70 border-dashed text-foreground/70 transition hover:bg-muted/60"
        >
          <KeyRoundIcon className="size-6" />
          <span className="text-sm">创建第一个访问 Token</span>
        </button>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {tokens.map((token) => (
          <Card key={token.id} className={!token.enabled ? "opacity-65" : ""}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                <CardTitle className="truncate text-base">{token.name}</CardTitle>
                <Badge variant={token.enabled ? "outline" : "secondary"}>{token.enabled ? "启用" : "已停用"}</Badge>
                <div className="ml-auto flex items-center gap-2">
                  <Switch
                    checked={token.enabled}
                    disabled={busyId === token.id}
                    onCheckedChange={() => void toggleToken(token)}
                    aria-label={`${token.enabled ? "停用" : "启用"} ${token.name}`}
                  />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={`删除 ${token.name}`}
                        disabled={busyId === token.id}
                      >
                        <Trash2Icon className="text-destructive" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>删除 Token「{token.name}」？</AlertDialogTitle>
                        <AlertDialogDescription>
                          删除后，使用此 Token 的外部 Agent 会立即无法访问 ARTEX。此操作不可撤销。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => void removeToken(token)}>
                          确认删除
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs">{token.prefix}…</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
                <span>{token.tools.length} 个授权工具</span>
                <span>最近使用：{token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "从未使用"}</span>
              </div>
              <Button variant="outline" size="sm" className="w-fit" onClick={() => openEdit(token)}>
                <PencilIcon /> 编辑名称与授权
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={created !== null} onOpenChange={(open) => (!open ? setCreated(null) : undefined)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Token「{created?.name}」已创建</DialogTitle>
            <DialogDescription>
              请立即复制配置。完整 Token 只显示这一次，关闭后无法从 ARTEX 再次读取。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>MCP 配置</Label>
            <Textarea
              value={config}
              readOnly
              className="min-h-[280px] font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
          </div>
          <DialogFooter>
            <CopyButton text={config} label="复制 MCP 配置" successMessage="MCP 配置已复制" variant="default" />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => (!open ? setEditing(null) : undefined)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑 Token 授权</DialogTitle>
            <DialogDescription>授权变更即时生效；取消所有工具后，Token 将无法执行任何操作。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="mcp-token-name">名称</Label>
            <Input
              id="mcp-token-name"
              value={editName}
              maxLength={64}
              onChange={(event) => setEditName(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>工具白名单</Label>
              <span className="text-muted-foreground text-xs">
                已选 {editTools.length} / {tools.length}
              </span>
            </div>
            <div className="max-h-[42vh] divide-y overflow-y-auto rounded-lg border px-3">
              {tools.map((tool) => (
                <label
                  key={tool.name}
                  htmlFor={`mcp-tool-${tool.name}`}
                  className="flex cursor-pointer items-start gap-3 py-3"
                >
                  <Checkbox
                    id={`mcp-tool-${tool.name}`}
                    className="mt-0.5"
                    checked={editTools.includes(tool.name)}
                    onCheckedChange={(checked) =>
                      setEditTools((current) =>
                        checked === true ? [...current, tool.name] : current.filter((name) => name !== tool.name),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="font-medium font-mono text-xs">{tool.name}</code>
                      {tool.read_only ? <Badge variant="outline">只读</Badge> : null}
                      {tool.dangerous ? (
                        <Badge variant="secondary" className="text-amber-600">
                          <AlertTriangleIcon className="size-3" /> 高风险
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-muted-foreground text-xs leading-relaxed">
                      {tool.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={() => void saveEdit()} disabled={saving}>
              {saving ? "保存中…" : "保存授权"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

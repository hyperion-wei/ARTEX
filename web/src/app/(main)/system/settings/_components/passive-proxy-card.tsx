"use client";

import * as React from "react";

import { CopyIcon, DownloadIcon, RadioTowerIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ProxyGuard } from "@/lib/types";

// 被动代理卡片：把流量记录能力开放给用户自己的浏览器/工具。
//
// 它管的是【另一个监听实例】。Agent 走的是启动参数 -proxy 给的内部代理，那个实例
// 永远不认证、不看白名单、全量记录——本页怎么改都不会动到 Agent 那条链路，也不需要
// 重建 Agent。两个实例写同一份流量库，所以 AI 用 traffic_search 查到的仍是全部流量。
export function PassiveProxyCard() {
  const [cfg, setCfg] = React.useState<ProxyGuard | null>(null);
  const [enabled, setEnabled] = React.useState(false);
  const [listen, setListen] = React.useState("");
  const [authOn, setAuthOn] = React.useState(false);
  const [user, setUser] = React.useState("");
  const [pass, setPass] = React.useState("");
  const [allowText, setAllowText] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // 读取失败与「本实例没跑代理」是两回事：前者要给重试入口，不能把代理明明在跑
  // 却因一次拉取失败说成不可用。
  const [loadError, setLoadError] = React.useState("");
  const [downloadingCA, setDownloadingCA] = React.useState(false);
  // 会断掉现有客户端的变更（开认证 / 换端口）先存下提示语，让用户确认一次。
  const [pendingConfirm, setPendingConfirm] = React.useState<string | null>(null);

  const fill = (v: ProxyGuard) => {
    setCfg(v);
    setEnabled(v.enabled);
    // 未启用时监听框留个默认值，用户一开开关就能直接保存，不用先猜端口。
    setListen(v.listen || "127.0.0.1:8789");
    setAuthOn(v.auth_enabled);
    setUser(v.user);
    setPass(v.pass);
    setAllowText(v.allowlist.join("\n"));
  };

  const load = React.useCallback(() => {
    setLoaded(false);
    setLoadError("");
    api
      .trafficProxy()
      .then(fill)
      .catch((e) => setLoadError(String((e as Error)?.message ?? e)))
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const doSave = async () => {
    setPendingConfirm(null);
    setSaving(true);
    try {
      const r = await api.setTrafficProxy({
        // 关掉被动代理 = 传空监听地址，后端会 DisablePassive 并清空持久化值。
        listen: enabled ? listen.trim() : "",
        user: authOn ? user.trim() : "",
        pass: authOn ? pass : "",
        allow_text: allowText,
      });
      fill(r.proxy);
      toast.success(enabled ? "被动代理已生效" : "被动代理已关闭", { description: r.note });
    } catch (e) {
      toast.error(`保存失败：${String((e as Error)?.message ?? e)}`);
      // 失败可能只改了运行时状态（如端口不可用），回读一次让页面显示真实情况。
      api.trafficProxy().then(fill).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const turningOnAuth = enabled && authOn && !(cfg?.auth_enabled ?? false);
    const moving = enabled && listen.trim() !== "" && listen.trim() !== (cfg?.listen ?? "");
    if (turningOnAuth || moving) {
      setPendingConfirm(
        turningOnAuth
          ? "开启代理密码后，任何没带凭据的客户端会立刻被 407 拒掉。如果你的浏览器或系统代理正指向被动代理这个地址，它会当场断网——需要在那个客户端里补上代理账号密码。"
          : "改监听地址会关掉旧端口上的被动代理。如果你的浏览器正把它当代理用，会立刻连不上，需要把代理设置一起改成新地址。",
      );
      return;
    }
    await doSave();
  };

  const copy = async () => {
    if (!cfg?.proxy_url) return;
    try {
      await navigator.clipboard.writeText(cfg.proxy_url);
      toast.success("被动代理地址已复制");
    } catch {
      toast.error("复制失败，请手动选中地址");
    }
  };

  const downloadCA = async () => {
    setDownloadingCA(true);
    try {
      await api.downloadTrafficCA();
      toast.success("CA 证书已下载（artex-mitm-ca.pem）");
    } catch (e) {
      toast.error(`下载 CA 失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setDownloadingCA(false);
    }
  };

  return (
    <Card className="mb-4 break-inside-avoid md:mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RadioTowerIcon className="size-4" />
          被动代理
        </CardTitle>
        <CardDescription>
          给你的浏览器、Burp 或命令行工具用的独立代理端口。流量经过它就会落进同一个流量库，
          AI 可以用 traffic_search / traffic_get 分析。
          <br />
          这里的<b>端口、密码、白名单只作用于被动代理</b>，与 Agent 无关——Agent 的流量始终全量记录，
          不受本页任何设置影响。
          <br />
          <b>域名白名单</b>：留空=经过的都记录；填了则<b>只记录名单内域名</b>，名单外照常直通（不解密、不落库）。
          条目 <code>example.com</code> 含其所有子域，也可写 <code>api.example.com</code> 只匹配该主机。
          <br />
          <b>代理密码</b>：走 HTTP 标准的 <code>Proxy-Authorization</code>。不设密码时，任何能连到该端口的
          进程都能借它出网并写入流量库——若监听地址不是 127.0.0.1，请务必设密码。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!loaded && !loadError ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : loadError ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-red-600">读取代理配置失败：{loadError}</p>
            <p className="text-xs text-muted-foreground">
              后端不可达时不要改代理配置；先确认 artex 服务正常，或检查本机代理设置是否把 127.0.0.1 也走了代理。
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={load}>
              重试
            </Button>
          </div>
        ) : !cfg?.available ? (
          <p className="text-sm text-amber-700">
            本实例没有跑流量代理（启动时 <code>-proxy</code> 为空），被动代理不可用。用
            <code>-proxy 127.0.0.1:8788</code> 重新启动后即可在此配置。
          </p>
        ) : (
          <>
            {/* Agent 侧只读说明：让人一眼看清「改这里不会影响 AI 的记录」 */}
            <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Agent 内部代理：<code className="font-mono">{cfg.agent_addr || "—"}</code>
                {cfg.capture_on ? " · 流量捕获已开启，Agent 目标流量正经此全量记录" : " · 流量捕获已关闭，Agent 未注入代理"}
              </span>
              <span className="text-muted-foreground">
                本页的端口 / 密码 / 白名单<b>不作用于它</b>，Agent 的流量记录不受影响。
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="pp-enabled" className="text-sm font-normal text-muted-foreground">
                {enabled ? "被动代理正在监听，可被浏览器/工具使用" : "未启用（不额外开放端口）"}
              </Label>
              <Switch id="pp-enabled" checked={enabled} disabled={saving} onCheckedChange={setEnabled} />
            </div>

            {enabled && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pp-url" className="text-sm font-normal text-muted-foreground">
                    被动代理地址（粘进浏览器/工具的代理设置）
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input id="pp-url" readOnly value={cfg.proxy_url || ""} className="font-mono text-xs" />
                    <Button type="button" variant="outline" size="sm" onClick={copy} disabled={!cfg.proxy_url}>
                      <CopyIcon className="size-3.5" /> 复制
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pp-listen" className="text-sm font-normal text-muted-foreground">
                    监听地址 <code>host:port</code>
                  </Label>
                  <Input
                    id="pp-listen"
                    autoComplete="off"
                    placeholder={`不能与 Agent 内部代理（${cfg.agent_addr}）或平台端口相同`}
                    value={listen}
                    disabled={saving}
                    onChange={(e) => setListen(e.target.value)}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="pp-auth" className="text-sm font-normal text-muted-foreground">
                    {authOn ? "要求代理密码" : "不要求认证（任何能连上该端口的进程都可用）"}
                  </Label>
                  <Switch id="pp-auth" checked={authOn} disabled={saving} onCheckedChange={setAuthOn} />
                </div>
                {authOn && (
                  <div className="flex gap-2">
                    <Input
                      autoComplete="off"
                      placeholder="代理用户名"
                      value={user}
                      disabled={saving}
                      onChange={(e) => setUser(e.target.value)}
                    />
                    <Input
                      autoComplete="new-password"
                      placeholder="代理密码（至少 6 位）"
                      value={pass}
                      disabled={saving}
                      onChange={(e) => setPass(e.target.value)}
                    />
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pp-allow" className="text-sm font-normal text-muted-foreground">
                    域名白名单（每行一个，留空=全部记录）
                  </Label>
                  <Textarea
                    id="pp-allow"
                    rows={4}
                    className="font-mono text-xs"
                    placeholder={"example.com\napi.target.cn\n# 以 # 开头的行会被忽略"}
                    value={allowText}
                    disabled={saving}
                    onChange={(e) => setAllowText(e.target.value)}
                  />
                </div>
              </>
            )}

            {/* CA 与被动代理开关无关：只要想抓 HTTPS 就得信任它 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>抓 HTTPS 需要客户端信任本机 CA：</span>
                <Button type="button" variant="outline" size="sm" onClick={downloadCA} disabled={downloadingCA}>
                  <DownloadIcon className="size-3.5" />
                  {downloadingCA ? "下载中…" : "下载 CA 证书"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                导入方式：Windows 双击证书 → 安装证书 → 「受信任的根证书颁发机构」；macOS 用钥匙串导入并设为
                「始终信任」；手机或其它设备同样导入该文件。本机路径：
                <code className="font-mono break-all">{cfg.ca_cert_path}</code>
              </p>
            </div>

            <div className="flex justify-end">
              <Button type="button" onClick={save} disabled={!loaded || saving}>
                {saving ? "保存中…" : "保存并生效"}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={pendingConfirm !== null} onOpenChange={(o) => !o && setPendingConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>这次变更会断开现有客户端</AlertDialogTitle>
            <AlertDialogDescription>{pendingConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不保存</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doSave();
              }}
            >
              我已知道，继续保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

"use client";

import * as React from "react";

import {
  BuildingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  LinkIcon,
  type LucideIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { AssetDslSearch } from "@/components/asset-dsl-search";
import { ScopeTextEditor } from "@/components/scope-text-editor";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { parseCompanyScopeText } from "@/lib/company-scope";
import type {
  Asset,
  AssetInsert,
  Company,
  CompanyScopeRule,
  EndpointAuth,
  EndpointAuthField,
  EndpointAuthInput,
  EndpointAuthKind,
  NewAssetType,
  Task,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700",
  POST: "bg-blue-100 text-blue-700",
  PUT: "bg-amber-100 text-amber-700",
  PATCH: "bg-orange-100 text-orange-700",
  DELETE: "bg-red-100 text-red-700",
  HEAD: "bg-purple-100 text-purple-700",
  OPTIONS: "bg-slate-100 text-slate-600",
};

function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none",
        METHOD_COLOR[m] ?? "bg-muted text-muted-foreground",
      )}
    >
      {m || "—"}
    </span>
  );
}

function statusTone(code: number) {
  if (code >= 500) return "text-red-500";
  if (code >= 400) return "text-amber-500";
  if (code >= 300) return "text-blue-500";
  if (code >= 200) return "text-emerald-500";
  return "text-muted-foreground";
}

const PAGE_SIZES = [25, 50, 100, 200];

const TABS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "company", label: "企业", icon: BuildingIcon },
  { key: "root_domain", label: "根域名", icon: GlobeIcon },
  { key: "ip", label: "IP", icon: NetworkIcon },
  { key: "subdomain", label: "子域名", icon: GlobeIcon },
  { key: "app", label: "应用", icon: SmartphoneIcon },
  { key: "service", label: "服务", icon: LayoutTemplateIcon },
  { key: "endpoint", label: "接口", icon: LinkIcon },
];

export default function AssetsPage() {
  const [rows, setRows] = React.useState<Asset[]>([]);
  const [total, setTotal] = React.useState(0);
  const [companies, setCompanies] = React.useState<Company[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [tab, setTab] = React.useState("company");
  const [query, setQuery] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(50);
  const [dslError, setDslError] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const assetsRequestRef = React.useRef(0);
  const [rowsTab, setRowsTab] = React.useState("");

  // asset selection & delete
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [deleteIds, setDeleteIds] = React.useState<number[]>([]);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // company delete
  const [companyDeleteTarget, setCompanyDeleteTarget] = React.useState<Company | null>(null);
  const [companyDeleteAssets, setCompanyDeleteAssets] = React.useState(false);
  const [companyDeleting, setCompanyDeleting] = React.useState(false);

  // Companies + per-type counts (tab badges) — loaded on demand, no background polling.
  const loadMeta = React.useCallback(() => {
    api
      .companies()
      .then(setCompanies)
      .catch(() => {
        /* Keep the last successful company snapshot on a transient failure. */
      });
    api
      .assetCounts()
      .then(setCounts)
      .catch(() => {
        /* Keep the last successful counters on a transient failure. */
      });
  }, []);

  // Manual refresh: reload counts/companies and re-fetch the current page.
  const refresh = React.useCallback(() => {
    loadMeta();
    setRefreshKey((k) => k + 1);
    setSelected(new Set());
  }, [loadMeta]);

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: number[]) => {
    setSelected((prev) => {
      const allSelected = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        ids.forEach((id) => {
          next.delete(id);
        });
      } else {
        ids.forEach((id) => {
          next.add(id);
        });
      }
      return next;
    });
  };

  const openDelete = (ids: number[]) => {
    setDeleteIds(ids);
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const res = await api.deleteAssets(deleteIds);
      toast.success(`已删除 ${res.deleted} 条资产`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error("删除失败：" + String((e as Error)?.message ?? e));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const confirmDeleteCompany = async () => {
    if (!companyDeleteTarget) return;
    setCompanyDeleting(true);
    try {
      const res = await api.deleteCompany(companyDeleteTarget.id, companyDeleteAssets);
      const msg =
        companyDeleteAssets && res.assets_deleted > 0
          ? `已删除企业，同时删除 ${res.assets_deleted} 条资产`
          : "已删除企业";
      toast.success(msg);
      refresh();
    } catch (e) {
      toast.error("删除失败：" + String((e as Error)?.message ?? e));
    } finally {
      setCompanyDeleting(false);
      setCompanyDeleteTarget(null);
      setCompanyDeleteAssets(false);
    }
  };

  React.useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  // Reset query + page + selection when switching tabs
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab changes intentionally reset tab-local controls.
  React.useEffect(() => {
    setQuery("");
    setDslError("");
    setSelected(new Set());
    setRows([]);
    setRowsTab("");
    setTotal(0);
    setLoaded(false);
  }, [tab]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: these controls intentionally reset server pagination.
  React.useEffect(() => setPage(0), [tab, size, query]);

  const dslMode = query.trim() !== "";

  // Server-side paginated page loader for the active data tab (company tab excluded).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an explicit manual-reload trigger.
  React.useEffect(() => {
    if (tab === "company") return;
    const request = ++assetsRequestRef.current;
    const dsl = query.trim();
    setLoading(true);
    const offset = page * size;
    const run = async () => {
      try {
        const r = dsl ? await api.searchAssets(dsl, tab, size, offset) : await api.assets(tab, size, offset);
        if (assetsRequestRef.current !== request) return;
        setRows(r.assets);
        setRowsTab(tab);
        setTotal(r.total);
        setDslError("");
      } catch (e) {
        if (assetsRequestRef.current !== request) return;
        setDslError(String((e as Error)?.message ?? e));
        setRows([]);
        setRowsTab(tab);
        setTotal(0);
      } finally {
        if (assetsRequestRef.current === request) {
          setLoading(false);
          setLoaded(true);
        }
      }
    };
    const tid = setTimeout(run, dsl ? 400 : 0);
    return () => {
      clearTimeout(tid);
      if (assetsRequestRef.current === request) assetsRequestRef.current++;
    };
  }, [tab, page, size, query, refreshKey]);

  React.useEffect(() => {
    if (tab === "company") return;
    const lastPage = Math.max(0, Math.ceil(total / size) - 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, size, tab, total]);

  const companyById = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const c of companies) m.set(c.id, c.name);
    return m;
  }, [companies]);

  const companyName = (id?: number) => (id ? (companyById.get(id) ?? "") : "");

  const tabCounts: Record<string, number> = { ...counts, company: companies.length };
  const totalAssets = Object.values(counts).reduce((a, b) => a + b, 0);

  // rows are already the current server-side page.
  const tabData = (type: string): Asset[] => (rowsTab === type ? rows : []);
  const currentRows = tabData(tab);
  const slice = <T,>(list: T[]) => list;

  // 接口鉴权档案：随本页接口列表一次批量取回（key=asset_id）。只对接口 tab 拉，
  // 其余类型不相关，免得白打一次接口。
  const [authByAsset, setAuthByAsset] = React.useState<Record<number, EndpointAuth>>({});
  const [authEditing, setAuthEditing] = React.useState<Asset | null>(null);
  const endpointIdsKey = tab === "endpoint" ? currentRows.map((a) => a.id).join(",") : "";
  React.useEffect(() => {
    if (!endpointIdsKey) return;
    let alive = true;
    api
      .endpointAuthByIDs(endpointIdsKey.split(",").map(Number))
      .then((items) => {
        if (alive) setAuthByAsset(Object.fromEntries(items.map((it) => [it.asset_id, it])));
      })
      .catch((e) => {
        if (alive) toast.error(`读取鉴权信息失败：${(e as Error).message}`);
      });
    return () => {
      alive = false;
    };
  }, [endpointIdsKey]);

  const searchBox = (
    <AssetDslSearch
      query={query}
      onChange={setQuery}
      loading={loading}
      error={dslError}
      count={dslMode ? total : undefined}
    />
  );

  return (
    <div className="flex h-[calc(100vh-6rem)] min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">资产</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            共 <span className="tabular-nums">{totalAssets}</span> 项资产
          </span>
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" onClick={() => openDelete(Array.from(selected) as number[])}>
              <Trash2Icon className="size-3.5" /> 删除已选 ({selected.size})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} /> 刷新
          </Button>
          <AssetDialog onSaved={refresh} />
          <CompanyDialog onSaved={refresh} />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="overflow-x-auto overflow-y-hidden">
          <TabsList variant="default">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                <t.icon className="size-3.5" />
                {t.label}
                <span className="ml-1 tabular-nums text-muted-foreground">{tabCounts[t.key]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* 企业 */}
        <TabsContent value="company" className="mt-0 flex min-h-0 flex-1 flex-col">
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
            <div className="min-h-0 flex-1 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>企业</TableHead>
                    <TableHead className="w-24 text-right">资产数</TableHead>
                    <TableHead>资产范围</TableHead>
                    <TableHead className="w-36 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companies.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <CompanyAvatar name={c.name} logo={c.logo} />
                          <span className="font-medium">{c.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{c.asset_count}</TableCell>
                      <TableCell>
                        {c.scope?.length ? (
                          <div className="flex flex-wrap gap-1">
                            {c.scope.map((s, i) => (
                              <Badge key={i} variant="secondary" className="font-mono text-[11px]">
                                {s.raw}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">未设置范围</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <EditScopeDialog company={c} onSaved={refresh} />
                          <AppendScopeDialog company={c} onSaved={refresh} />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              setCompanyDeleteTarget(c);
                              setCompanyDeleteAssets(false);
                            }}
                            aria-label={`删除企业 ${c.name}`}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {companies.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                        还没有企业。点击右上角「新增企业」并填写资产范围，系统会自动认领命中的资产。
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </TabsContent>

        {/* 根域名 */}
        <TabsContent value="root_domain" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "域名", "ICP 备案", "归属企业", ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={currentRows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("root_domain")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs font-medium">{a.domain}</TableCell>
                <TableCell className="text-xs">{a.icp || "—"}</TableCell>
                <TableCell className="text-xs">
                  {companyName(a.company_id) || <span className="text-muted-foreground">未归属</span>}
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                    aria-label={`删除资产 ${a.domain || a.id}`}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* IP */}
        <TabsContent value="ip" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "IP", "C段", "绑定域名", "开放端口", ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={currentRows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("ip")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs font-medium">{a.ip}</TableCell>
                <TableCell className="font-mono text-xs">{a.c_segment || "—"}</TableCell>
                <TableCell>
                  <Chips items={a.bound_domains ?? []} mono />
                </TableCell>
                <TableCell>
                  <Chips
                    items={(a.open_ports ?? []).map((p) => (p.service ? `${p.port}/${p.service}` : String(p.port)))}
                    mono
                  />
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                    aria-label={`删除资产 ${a.ip || a.id}`}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* 子域名 */}
        <TabsContent value="subdomain" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "域名", "根域名", "解析类型", "解析值", ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={currentRows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("subdomain")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs font-medium">{a.domain}</TableCell>
                <TableCell className="font-mono text-xs">{a.root_domain || "—"}</TableCell>
                <TableCell className="text-xs">{a.record_type || "—"}</TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs">
                  {(Array.isArray(a.record_value) ? a.record_value.join(", ") : a.record_value) || "—"}
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                    aria-label={`删除资产 ${a.domain || a.id}`}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* 应用 */}
        <TabsContent value="app" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "应用名", "Bundle ID", "分类", "ICP 备案", ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={currentRows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("app")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="text-xs font-medium">{a.app_name || "—"}</TableCell>
                <TableCell className="font-mono text-xs">{a.bundle_id || "—"}</TableCell>
                <TableCell className="text-xs">{a.category || "—"}</TableCell>
                <TableCell className="text-xs">{a.app_icp || "—"}</TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                    aria-label={`删除资产 ${a.app_name || a.id}`}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>

        {/* 服务 */}
        <TabsContent value="service" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "服务", "域名", "IP", "端口", "状态码", "标题", "指纹", "认证", ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={currentRows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("service")).map((a) => {
              const isHttp = a.service_type === "http";
              const svc = a.service_name || (isHttp ? "http" : "") || a.service_type || "";
              let domainCell: React.ReactNode = "—";
              if (isHttp && a.url) {
                domainCell = (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {a.domain || a.url}
                  </a>
                );
              } else if (a.domain) {
                domainCell = a.domain;
              }
              return (
                <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                  <TableCell className="w-8 pr-0">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={isHttp ? "default" : "secondary"} className="font-mono text-[10px]">
                      {svc || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate font-mono text-xs" title={a.domain || a.url}>
                    {domainCell}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.ip || "—"}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{a.port || "—"}</TableCell>
                  <TableCell>
                    {a.status_code != null ? (
                      <span className={cn("font-mono text-xs font-semibold tabular-nums", statusTone(a.status_code))}>
                        {a.status_code}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate text-xs" title={a.page_title}>
                    {a.page_title || "—"}
                  </TableCell>
                  <TableCell>
                    <Chips items={a.technologies ?? []} />
                  </TableCell>
                  <TableCell>
                    {(a.auth ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      (a.auth ?? []).map((authItem, i) => {
                        const item = authItem as Record<string, string>;
                        const label = item.type || item.username || "认证";
                        return (
                          <span key={i} className="inline-flex items-center gap-1 text-[11px]">
                            <KeyRoundIcon className="size-3 text-muted-foreground" />
                            <span className="font-mono">{label}</span>
                          </span>
                        );
                      })
                    )}
                  </TableCell>
                  <TableCell className="w-8 pl-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => openDelete([a.id])}
                      aria-label={`删除资产 ${a.url || a.id}`}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </AssetCard>
        </TabsContent>

        {/* 接口 */}
        <TabsContent value="endpoint" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          {searchBox}
          <AssetCard
            cols={["", "方法", "完整地址", "参数", "鉴权", ""]}
            loaded={loaded}
            total={total}
            page={page}
            size={size}
            onSize={setSize}
            onPage={setPage}
            rows={currentRows}
            selected={selected}
            onToggleAll={(ids) => toggleSelectAll(ids)}
          >
            {slice(tabData("endpoint")).map((a) => (
              <TableRow key={a.id} className={selected.has(a.id) ? "bg-muted/40" : undefined}>
                <TableCell className="w-8 pr-0">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id)} />
                </TableCell>
                <TableCell className="w-16">
                  <MethodBadge method={a.method || ""} />
                </TableCell>
                <TableCell className="max-w-sm truncate font-mono text-xs" title={a.url}>
                  {a.url || "—"}
                </TableCell>
                <TableCell>
                  <Chips
                    items={(a.params ?? []).map((p) => {
                      const item = p as Record<string, string>;
                      return item.name ? `${item.name}(${item.location || "?"})` : "?";
                    })}
                    mono
                  />
                </TableCell>
                <TableCell>
                  <EndpointAuthBadge auth={authByAsset[a.id]} onEdit={() => setAuthEditing(a)} />
                </TableCell>
                <TableCell className="w-8 pl-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => openDelete([a.id])}
                    aria-label={`删除资产 ${a.url || a.id}`}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </AssetCard>
        </TabsContent>
      </Tabs>

      <EndpointAuthDialog
        asset={authEditing}
        auth={authEditing ? (authByAsset[authEditing.id] ?? null) : null}
        onClose={() => setAuthEditing(null)}
        onSaved={(saved) => {
          // 就地更新那一行：整页重拉会丢掉滚动位置，而保存只影响一条档案。
          setAuthByAsset((prev) => ({ ...prev, [saved.asset_id]: saved }));
          setAuthEditing(null);
        }}
        onDeleted={(id) =>
          setAuthByAsset((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          })
        }
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除 <span className="font-semibold tabular-nums">{deleteIds.length}</span>{" "}
              条资产记录，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!companyDeleteTarget}
        onOpenChange={(o) => {
          if (!o) {
            setCompanyDeleteTarget(null);
            setCompanyDeleteAssets(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除企业 · {companyDeleteTarget?.name}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>此操作将永久删除该企业及其资产范围配置，不可撤销。</p>
                <label
                  htmlFor="delete-assets-opt"
                  className="flex cursor-pointer items-center gap-2.5 rounded-md border p-3 hover:bg-muted/50"
                >
                  <Checkbox
                    id="delete-assets-opt"
                    checked={companyDeleteAssets}
                    onCheckedChange={(v) => setCompanyDeleteAssets(!!v)}
                  />
                  <span className="text-sm leading-snug">
                    同时删除该企业下的所有资产
                    <span className="block text-xs text-muted-foreground">不勾选则保留资产，仅取消归属关系</span>
                  </span>
                </label>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={companyDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteCompany();
              }}
              disabled={companyDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {companyDeleting ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AssetCard({
  cols,
  loaded,
  total,
  page,
  size,
  onSize,
  onPage,
  rows: dataRows,
  selected,
  onToggleAll,
  children,
}: {
  cols: string[];
  loaded: boolean;
  total: number;
  page: number;
  size: number;
  onSize: React.Dispatch<React.SetStateAction<number>>;
  onPage: React.Dispatch<React.SetStateAction<number>>;
  rows?: Asset[];
  selected?: Set<number>;
  onToggleAll?: (ids: number[]) => void;
  children: React.ReactNode;
}) {
  const childRows = React.Children.toArray(children);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const start = total === 0 ? 0 : page * size + 1;
  const end = page * size + childRows.length;

  const pageIds = dataRows?.map((r) => r.id) ?? [];
  const allSelected = pageIds.length > 0 && selected != null && pageIds.every((id) => selected.has(id));
  const someSelected = selected != null && pageIds.some((id) => selected.has(id));

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              {cols.map((c, i) =>
                c === "" && i === 0 && onToggleAll ? (
                  <TableHead key={i} className="w-8 pr-0">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={() => onToggleAll(pageIds)}
                    />
                  </TableHead>
                ) : (
                  <TableHead key={c + i}>{c}</TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {childRows.length > 0 ? (
              childRows
            ) : (
              <TableRow>
                <TableCell colSpan={cols.length} className="py-12 text-center text-sm text-muted-foreground">
                  {loaded ? "暂无数据。" : "加载中…"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {total > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <Select value={String(size)} onValueChange={(v) => onSize(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} / 页
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <span className="tabular-nums">
            {start}–{end} / {total}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                disabled={page <= 0}
                onClick={() => onPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeftIcon />
              </Button>
              <span className="tabular-nums">
                {page + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                disabled={page + 1 >= pageCount}
                onClick={() => onPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Chips({ items, mono }: { items: string[]; mono?: boolean }) {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {clean.map((s, i) => (
        <Badge key={i} variant="outline" className={cn("text-[10px]", mono && "font-mono")}>
          {s}
        </Badge>
      ))}
    </div>
  );
}

function CompanyAvatar({ name, logo }: { name: string; logo?: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <Avatar className="size-7 shrink-0">
      {logo ? <AvatarImage src={logo} alt={name} /> : null}
      <AvatarFallback className="text-xs">{initial}</AvatarFallback>
    </Avatar>
  );
}

// 后端返回的 warnings 说的是既有数据问题（不是本次提交的行有错），保存本身已经
// 成功。给更长的停留时间，因为它需要用户去处理具体的资产，扫一眼标题不够。
function showScopeWarnings(warnings?: string[]) {
  for (const warning of warnings ?? []) {
    toast.warning(warning, { duration: 15000 });
  }
}

function savedScopeRules(company: Company): CompanyScopeRule[] {
  return (company.scope ?? [])
    .map((scope) => ({ kind: scope.kind, value: scope.raw.trim() }))
    .filter((scope) => scope.value);
}

function savedScopeText(company: Company): string {
  return savedScopeRules(company)
    .map((scope) => scope.value)
    .join("\n");
}

// 新增企业使用与任务、LLM 编辑一致的右侧抽屉。
function CompanyDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [scopeText, setScopeText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const parsedScope = React.useMemo(() => parseCompanyScopeText(scopeText), [scopeText]);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setScopeText("");
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("请填写企业名称");
      return;
    }
    if (parsedScope.errors.length > 0) {
      toast.error("请修正无效的资产范围");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createCompany(name.trim(), parsedScope.rules);
      const added = res.scope_added ?? 0;
      const invalid = res.scope_invalid ?? 0;
      if (invalid > 0) toast.warning(`已创建企业，添加 ${added} 条范围；${invalid} 行无效`);
      else toast.success(`已创建企业，添加 ${added} 条范围`);
      setOpen(false);
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/:\s*409$/.test(msg)) toast.error("企业已存在，请换个名称");
      else toast.error(`保存失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm">
          <BuildingIcon data-icon="inline-start" /> 新增企业
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full! max-w-none! gap-0 p-0 sm:w-[520px]! sm:max-w-[520px]!">
        <SheetHeader className="border-b p-6">
          <SheetTitle>新增企业</SheetTitle>
          <SheetDescription>配置企业及其资产范围。关键词只作为 Agent 提示，不会自动归属资产。</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cn-name">企业名称</FieldLabel>
              <Input
                id="cn-name"
                placeholder="如 Acme Corp（名称唯一）"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <ScopeTextEditor id="cn-scope" value={scopeText} onValueChange={setScopeText} parsed={parsedScope} />
          </FieldGroup>
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || parsedScope.errors.length > 0}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// 抽屉里的类型比资产模型多一个 UI 专用的 service_other：非 HTTP 端口服务在库里仍是
// type=service（后端靠 url 是否为空分流 http / other），Radix Select 又不允许两个
// 选项同 value，所以在表单层拆开、提交时再映射回去。
type DialogAssetType = NewAssetType | "service_other";

const ENDPOINT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// 新增资产抽屉：调用 POST /api/assets 登记资产。企业归属由企业「资产范围」
// 规则自动匹配（域名 → IP → ICP），无需（也无法）手选企业。
function AssetDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [dtype, setDtype] = React.useState<DialogAssetType>("root_domain");
  const [bulkText, setBulkText] = React.useState("");
  const [icp, setIcp] = React.useState("");
  const [appName, setAppName] = React.useState("");
  const [bundleId, setBundleId] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [appDesc, setAppDesc] = React.useState("");
  const [appIcp, setAppIcp] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [serviceIp, setServiceIp] = React.useState("");
  const [method, setMethod] = React.useState("GET");
  const [svcDomain, setSvcDomain] = React.useState("");
  const [svcIp, setSvcIp] = React.useState("");
  const [svcPort, setSvcPort] = React.useState("");
  const [svcName, setSvcName] = React.useState("");
  const [taskId, setTaskId] = React.useState("");
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [busy, setBusy] = React.useState(false);

  const type: NewAssetType = dtype === "service_other" ? "service" : dtype;
  const bulkMode = dtype === "root_domain" || dtype === "subdomain" || dtype === "ip";
  const bulkLines = bulkText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  React.useEffect(() => {
    if (!open) return;
    setDtype("root_domain");
    setBulkText("");
    setIcp("");
    setAppName("");
    setBundleId("");
    setCategory("");
    setAppDesc("");
    setAppIcp("");
    setUrl("");
    setServiceIp("");
    setMethod("GET");
    setSvcDomain("");
    setSvcIp("");
    setSvcPort("");
    setSvcName("");
    setTaskId("");
    api
      .tasks()
      .then((r) => setTasks(r.tasks))
      .catch(() => setTasks([]));
  }, [open]);

  const submit = async () => {
    let assets: AssetInsert[] = [];
    if (bulkMode) {
      assets = bulkLines.map((v) => {
        if (dtype === "ip") return { type: "ip", ip: v };
        if (dtype === "root_domain") {
          return { type: dtype, domain: v, ...(icp.trim() ? { icp: icp.trim() } : {}) };
        }
        return { type: dtype, domain: v };
      });
    } else if (dtype === "app") {
      assets = [
        {
          type: dtype,
          app_name: appName.trim(),
          bundle_id: bundleId.trim(),
          category: category.trim(),
          description: appDesc.trim(),
          app_icp: appIcp.trim(),
        },
      ];
    } else if (dtype === "endpoint") {
      // method 是后端唯一键的一部分（uq_av2_endpoint 是 url+method），缺了会被拒。
      assets = [
        {
          type: "endpoint",
          url: url.trim(),
          method,
          ...(serviceIp.trim() ? { service_ip: serviceIp.trim() } : {}),
        },
      ];
    } else if (dtype === "service_other") {
      assets = [
        {
          type: "service",
          ...(svcDomain.trim() ? { domain: svcDomain.trim() } : {}),
          ...(svcIp.trim() ? { ip: svcIp.trim() } : {}),
          port: Number(svcPort) || 0,
          ...(svcName.trim() ? { service_name: svcName.trim() } : {}),
        },
      ];
    } else {
      assets = [{ type, url: url.trim(), ...(serviceIp.trim() ? { service_ip: serviceIp.trim() } : {}) }];
    }
    setBusy(true);
    try {
      const res = await api.insertAssets(taskId ? Number(taskId) : 0, assets);
      const ok = res.results?.length ?? 0;
      const bad = res.errors ?? [];
      if (bad.length > 0) toast.warning(`已登记 ${ok} 条，失败 ${bad.length} 条：${bad[0].error}`);
      else toast.success(`已登记 ${ok} 条资产`);
      if (ok > 0) {
        setOpen(false);
        onSaved();
      }
    } catch (e) {
      toast.error(`登记失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = () => {
    if (bulkMode) return bulkLines.length > 0;
    if (dtype === "app") return appName.trim() !== "";
    if (dtype === "endpoint") return url.trim() !== "" && method !== "";
    if (dtype === "service_other") return (svcIp.trim() !== "" || svcDomain.trim() !== "") && Number(svcPort) > 0;
    return url.trim() !== "";
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm">
          <PlusIcon data-icon="inline-start" /> 新增资产
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full! max-w-none! gap-0 p-0 sm:w-[520px]! sm:max-w-[520px]!">
        <SheetHeader className="border-b p-6">
          <SheetTitle>新增资产</SheetTitle>
          <SheetDescription>
            手工登记资产；企业归属由企业「资产范围」自动匹配（域名 → IP → ICP），无需手选。
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="na-type">资产类型</FieldLabel>
              <Select value={dtype} onValueChange={(v) => setDtype(v as DialogAssetType)}>
                <SelectTrigger id="na-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root_domain">根域名</SelectItem>
                  <SelectItem value="subdomain">子域名</SelectItem>
                  <SelectItem value="ip">IP</SelectItem>
                  <SelectItem value="app">应用（App）</SelectItem>
                  <SelectItem value="service">HTTP 服务</SelectItem>
                  <SelectItem value="service_other">其它服务（端口）</SelectItem>
                  <SelectItem value="endpoint">接口（Endpoint）</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {bulkMode && (
              <Field>
                <FieldLabel htmlFor="na-bulk">
                  {type === "ip" ? "IP 列表（每行一个）" : "域名列表（每行一个）"}
                </FieldLabel>
                <Textarea
                  id="na-bulk"
                  rows={6}
                  className="max-h-48"
                  placeholder={type === "ip" ? "1.2.3.4\n5.6.7.8" : "www.example.com\napi.example.com"}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                />
              </Field>
            )}
            {dtype === "root_domain" && (
              <Field>
                <FieldLabel htmlFor="na-icp">ICP 备案号（可选，批量共用）</FieldLabel>
                <Input
                  id="na-icp"
                  placeholder="如 京ICP备12345678号；可用于企业 ICP 规则归属"
                  value={icp}
                  onChange={(e) => setIcp(e.target.value)}
                />
              </Field>
            )}
            {dtype === "app" && (
              <>
                <Field>
                  <FieldLabel htmlFor="na-app-name">应用名称</FieldLabel>
                  <Input
                    id="na-app-name"
                    placeholder="如 ARTEX 官方 App"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-bundle">Bundle ID（可选）</FieldLabel>
                  <Input
                    id="na-bundle"
                    placeholder="如 com.example.app"
                    value={bundleId}
                    onChange={(e) => setBundleId(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-cat">分类（可选）</FieldLabel>
                  <Input
                    id="na-cat"
                    placeholder="如 社交 / 电商"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-desc">描述（可选）</FieldLabel>
                  <Input id="na-desc" value={appDesc} onChange={(e) => setAppDesc(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-app-icp">应用备案号（可选）</FieldLabel>
                  <Input id="na-app-icp" value={appIcp} onChange={(e) => setAppIcp(e.target.value)} />
                </Field>
              </>
            )}
            {dtype === "service" && (
              <>
                <Field>
                  <FieldLabel htmlFor="na-url">服务 URL</FieldLabel>
                  <Input
                    id="na-url"
                    placeholder="https://example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-svc-ip">归属 IP（可选）</FieldLabel>
                  <Input
                    id="na-svc-ip"
                    placeholder="如 1.2.3.4；命中企业 IP/CIDR 范围时用于归属"
                    value={serviceIp}
                    onChange={(e) => setServiceIp(e.target.value)}
                  />
                </Field>
              </>
            )}
            {dtype === "endpoint" && (
              <>
                <Field>
                  <FieldLabel htmlFor="na-ep-url">接口 URL</FieldLabel>
                  <Input
                    id="na-ep-url"
                    placeholder="https://example.com/api/user/list"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-ep-method">请求方法</FieldLabel>
                  <Select value={method} onValueChange={setMethod}>
                    <SelectTrigger id="na-ep-method" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENDPOINT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-ep-ip">归属 IP（可选）</FieldLabel>
                  <Input
                    id="na-ep-ip"
                    placeholder="如 1.2.3.4"
                    value={serviceIp}
                    onChange={(e) => setServiceIp(e.target.value)}
                  />
                </Field>
              </>
            )}
            {dtype === "service_other" && (
              <>
                <Field>
                  <FieldLabel htmlFor="na-so-domain">域名（可选，与 IP 至少填一个）</FieldLabel>
                  <Input
                    id="na-so-domain"
                    placeholder="如 db.example.com"
                    value={svcDomain}
                    onChange={(e) => setSvcDomain(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-so-ip">IP（可选，与域名至少填一个）</FieldLabel>
                  <Input id="na-so-ip" placeholder="如 1.2.3.4" value={svcIp} onChange={(e) => setSvcIp(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-so-port">端口</FieldLabel>
                  <Input
                    id="na-so-port"
                    type="number"
                    placeholder="如 3306"
                    value={svcPort}
                    onChange={(e) => setSvcPort(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="na-so-name">服务名（可选）</FieldLabel>
                  <Input
                    id="na-so-name"
                    placeholder="如 mysql / redis / ssh"
                    value={svcName}
                    onChange={(e) => setSvcName(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field>
              <FieldLabel htmlFor="na-task">关联任务（可选）</FieldLabel>
              <Select value={taskId} onValueChange={setTaskId}>
                <SelectTrigger id="na-task" className="w-full">
                  <SelectValue placeholder="不关联" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">不关联</SelectItem>
                  {tasks.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {(t.name || t.description || t.id).slice(0, 40)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !canSubmit()}>
            {busy ? "登记中…" : "登记"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------- 接口鉴权档案 ----------

const AUTH_KINDS: { value: EndpointAuthKind; label: string }[] = [
  { value: "unknown", label: "未判定" },
  { value: "none", label: "无需鉴权" },
  { value: "bearer", label: "Bearer Token" },
  { value: "jwt", label: "JWT" },
  { value: "cookie", label: "Cookie" },
  { value: "session", label: "Session" },
  { value: "api_key", label: "API Key" },
  { value: "basic", label: "Basic 账密" },
  { value: "oauth", label: "OAuth" },
  { value: "signature", label: "签名 sign" },
];

const FIELD_WHERE_LABELS: Record<string, string> = { header: "请求头", query: "URL 参数", body: "正文", cookie: "Cookie" };

/** {a:1,b:2} → "a=1\nb=2"，给 textarea 编辑用。 */
function kvToText(o?: Record<string, string>): string {
  return Object.entries(o ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** 反向解析；无 `=` 的行直接丢掉（不拿它当空键存进去）。 */
function textToKv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// EndpointAuthBadge 列表页那一列。未登记也要能一点就填，否则这个信息永远只能靠 AI 写。
function EndpointAuthBadge({ auth, onEdit }: { auth?: EndpointAuth; onEdit: () => void }) {
  let label = "未登记";
  let tone = "text-muted-foreground";
  if (auth) {
    if (!auth.needs_auth) {
      label = "免鉴权";
      tone = "text-muted-foreground";
    } else if (auth.verified) {
      label = "凭据已验证";
      tone = "text-emerald-700";
    } else if (auth.has_credential) {
      label = "已有凭据";
      tone = "text-blue-700";
    } else {
      label = "需鉴权·缺凭据";
      tone = "text-red-600";
    }
  }
  return (
    <button type="button" onClick={onEdit} className={cn("inline-flex items-center gap-1 text-xs hover:underline", tone)}>
      <KeyRoundIcon className="size-3.5" />
      {label}
      {auth && auth.auth_kind !== "unknown" ? (
        <span className="font-mono text-[11px] text-muted-foreground">{auth.auth_kind}</span>
      ) : null}
    </button>
  );
}

// EndpointAuthDialog 登记/修改一条接口的鉴权档案。
//
// 凭据默认收起来：库里存的是明文（AI 要拿它复放请求），所以进页不能一屏铺满
// token；点「展开并明文编辑」才把值渲染出来。
function EndpointAuthDialog({
  asset,
  auth,
  onClose,
  onSaved,
  onDeleted,
}: {
  asset: Asset | null;
  auth: EndpointAuth | null;
  onClose: () => void;
  onSaved: (saved: EndpointAuth) => void;
  onDeleted: (assetId: number) => void;
}) {
  const [needsAuth, setNeedsAuth] = React.useState(true);
  const [authKind, setAuthKind] = React.useState<EndpointAuthKind>("unknown");
  const [hasCred, setHasCred] = React.useState(false);
  const [verified, setVerified] = React.useState(false);
  const [fields, setFields] = React.useState<EndpointAuthField[]>([]);
  const [headers, setHeaders] = React.useState("");
  const [cookies, setCookies] = React.useState("");
  const [params, setParams] = React.useState("");
  const [raw, setRaw] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [note, setNote] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const open = asset !== null;
  React.useEffect(() => {
    if (!open) return;
    setNeedsAuth(auth ? auth.needs_auth : true);
    setAuthKind(auth?.auth_kind ?? "unknown");
    setHasCred(auth?.has_credential ?? false);
    setVerified(auth?.verified ?? false);
    setFields(auth?.fields ? [...auth.fields] : []);
    setHeaders(kvToText(auth?.credential?.headers));
    setCookies(kvToText(auth?.credential?.cookies));
    setParams(kvToText(auth?.credential?.params));
    setRaw(auth?.credential?.raw ?? "");
    setUsername(auth?.credential?.account?.username ?? "");
    setPassword(auth?.credential?.account?.password ?? "");
    setNote(auth?.note ?? "");
    setReveal(false);
  }, [open, auth]);

  const credCount =
    Object.keys(textToKv(headers)).length +
    Object.keys(textToKv(cookies)).length +
    Object.keys(textToKv(params)).length +
    (raw.trim() ? 1 : 0) +
    (username.trim() || password ? 1 : 0);

  const save = async () => {
    if (!asset) return;
    const credential: EndpointAuthInput["credential"] = {
      headers: textToKv(headers),
      cookies: textToKv(cookies),
      params: textToKv(params),
    };
    if (username.trim() || password) credential.account = { username: username.trim(), password };
    if (raw.trim()) credential.raw = raw.trim();
    setBusy(true);
    try {
      const saved = await api.saveEndpointAuth({
        asset_id: asset.id,
        needs_auth: needsAuth,
        auth_kind: authKind,
        has_credential: hasCred,
        verified,
        fields: fields.filter((f) => f.name.trim()).map((f) => ({ ...f, name: f.name.trim() })),
        credential,
        source: "manual",
        confidence: 1,
        note: note.trim(),
      });
      toast.success("鉴权信息已保存");
      onSaved(saved);
    } catch (e) {
      toast.error(`保存失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!asset) return;
    setBusy(true);
    try {
      await api.deleteEndpointAuth(asset.id);
      toast.success("已删除该接口的鉴权档案");
      // 删完就没有对象可编辑了：列表那一格回到「未登记」，抽屉关掉。
      onDeleted(asset.id);
      onClose();
    } catch (e) {
      toast.error(`删除失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full! max-w-none! gap-0 p-0 sm:w-[560px]! sm:max-w-[560px]!">
        <SheetHeader className="border-b p-6">
          <SheetTitle>接口鉴权信息</SheetTitle>
          <SheetDescription>
            <span className="font-mono text-xs">
              {asset?.method ? `${asset.method} ` : ""}
              {asset?.url || asset?.domain || "—"}
            </span>
            <br />
            记录这个接口要不要鉴权、鉴权字段藏在哪儿、我们手上有没有可用凭据。AI 从流量里识别到也会写这里，以最后一次保存为准。
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-6">
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox id="na-needs" checked={needsAuth} onCheckedChange={(v) => setNeedsAuth(v === true)} />
              <FieldLabel htmlFor="na-needs">需要鉴权（取消勾选 = 已确认公开可访问）</FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="na-kind">鉴权类型</FieldLabel>
              <Select value={authKind} onValueChange={(v) => setAuthKind(v as EndpointAuthKind)}>
                <SelectTrigger id="na-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTH_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="na-has" checked={hasCred} onCheckedChange={(v) => setHasCred(v === true)} />
              <FieldLabel htmlFor="na-has">已有鉴权信息</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="na-verified"
                checked={verified}
                disabled={!needsAuth}
                onCheckedChange={(v) => setVerified(v === true)}
              />
              <FieldLabel htmlFor="na-verified">凭据已实际验证可用（用它请求成功过）</FieldLabel>
            </Field>
            <Field>
              <FieldLabel>鉴权字段</FieldLabel>
              <div className="flex flex-col gap-2">
                {fields.map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      className="flex-1"
                      placeholder="字段名，如 Authorization"
                      value={f.name}
                      onChange={(e) =>
                        setFields((prev) => prev.map((it, j) => (j === i ? { ...it, name: e.target.value } : it)))
                      }
                    />
                    <Select
                      value={f.where || "header"}
                      onValueChange={(v) => setFields((prev) => prev.map((it, j) => (j === i ? { ...it, where: v } : it)))}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(FIELD_WHERE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setFields((prev) => prev.filter((_, j) => j !== i))}
                      aria-label="删除该字段"
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setFields((prev) => [...prev, { name: "", where: "header" }])}
                >
                  <PlusIcon className="size-3.5" /> 添加字段
                </Button>
              </div>
            </Field>
            <Field>
              <FieldLabel>凭据（明文入库，供 AI 复放请求）</FieldLabel>
              {!reveal ? (
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{credCount > 0 ? `已存 ${credCount} 项凭据` : "暂无凭据"}</span>
                  <Button variant="outline" size="sm" onClick={() => setReveal(true)}>
                    <EyeIcon className="size-3.5" /> 展开并明文编辑
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">当前为明文显示，切走前注意旁边有没有人。</p>
                  <Field>
                    <FieldLabel htmlFor="na-cred-headers">请求头（每行 key=value）</FieldLabel>
                    <Textarea
                      id="na-cred-headers"
                      rows={3}
                      className="font-mono text-xs"
                      placeholder={'Authorization=Bearer eyJhbGci...\nX-Token=abc123'}
                      value={headers}
                      onChange={(e) => setHeaders(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="na-cred-cookies">Cookie（每行 key=value）</FieldLabel>
                    <Textarea
                      id="na-cred-cookies"
                      rows={2}
                      className="font-mono text-xs"
                      placeholder="PHPSESSID=3f2a..."
                      value={cookies}
                      onChange={(e) => setCookies(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="na-cred-params">URL/表单参数（每行 key=value）</FieldLabel>
                    <Textarea
                      id="na-cred-params"
                      rows={2}
                      className="font-mono text-xs"
                      placeholder="token=abc\nappid=wx123"
                      value={params}
                      onChange={(e) => setParams(e.target.value)}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Field className="flex-1">
                      <FieldLabel htmlFor="na-cred-user">账号</FieldLabel>
                      <Input id="na-cred-user" value={username} onChange={(e) => setUsername(e.target.value)} />
                    </Field>
                    <Field className="flex-1">
                      <FieldLabel htmlFor="na-cred-pass">口令</FieldLabel>
                      <Input
                        id="na-cred-pass"
                        type="text"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="na-cred-raw">整段原文（可选，如完整 Cookie 串）</FieldLabel>
                    <Textarea id="na-cred-raw" rows={2} className="font-mono text-xs" value={raw} onChange={(e) => setRaw(e.target.value)} />
                  </Field>
                </div>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="na-auth-note">备注</FieldLabel>
              <Textarea
                id="na-auth-note"
                rows={3}
                placeholder="怎么判断出来的、凭据从哪条流量拿到的、有没有限制（如 30 分钟内有效、只能读不能写）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            {auth ? (
              <p className="text-xs text-muted-foreground">
                来源：{auth.source === "ai" ? "AI 识别" : auth.source === "traffic" ? "流量提取" : "人工登记"}
                {auth.updated_by ? ` · ${auth.updated_by}` : ""} · 更新于 {auth.updated_at ? new Date(auth.updated_at).toLocaleString() : "—"}
              </p>
            ) : null}
          </FieldGroup>
        </div>
        <SheetFooter className="flex-row items-center justify-end gap-2 border-t p-4">
          {auth ? (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={remove} disabled={busy}>
              <Trash2Icon className="size-3.5" /> 删除档案
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// 编辑（覆盖）资产范围弹窗
function EditScopeDialog({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [scopeText, setScopeText] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const preservedScopeRules = React.useMemo(() => savedScopeRules(company), [company]);
  const parsedScope = React.useMemo(
    () => parseCompanyScopeText(scopeText, { preservedRules: preservedScopeRules }),
    [preservedScopeRules, scopeText],
  );

  React.useEffect(() => {
    if (!open) return;
    setScopeText(savedScopeText(company));
    setReason("");
  }, [open, company]);

  const submit = async () => {
    if (parsedScope.errors.length > 0) {
      toast.error("请修正无效的资产范围");
      return;
    }
    setBusy(true);
    try {
      const res = await api.updateCompanyScope(company.id, parsedScope.rules, reason);
      const errCount = res.invalid ?? 0;
      if (errCount > 0) toast.warning(`已保存；${errCount} 行无效`);
      else toast.success(`范围已更新，共 ${res.added} 条`);
      showScopeWarnings(res.warnings);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(`保存失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">
          编辑
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑资产范围 · {company.name}</DialogTitle>
          <DialogDescription>
            编辑后将替换全部现有范围。ICP 精确匹配资产，企业关键词仅作为 Agent 提示。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-2">
          <ScopeTextEditor
            id={`edit-company-scope-${company.id}`}
            value={scopeText}
            onValueChange={setScopeText}
            parsed={parsedScope}
          />
          <Field>
            <FieldLabel htmlFor="es-reason">归属依据（可选）</FieldLabel>
            <Input
              id="es-reason"
              placeholder="如 证书 / whois / ASN 佐证"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || parsedScope.errors.length > 0}>
            {busy ? "保存中…" : "覆盖保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 追加资产范围弹窗
function AppendScopeDialog({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [scopeText, setScopeText] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const parsedScope = React.useMemo(() => parseCompanyScopeText(scopeText), [scopeText]);

  React.useEffect(() => {
    if (!open) return;
    setScopeText("");
    setReason("");
  }, [open]);

  const submit = async () => {
    if (parsedScope.rules.length === 0) {
      toast.error("请填写要追加的范围");
      return;
    }
    if (parsedScope.errors.length > 0) {
      toast.error("请修正无效的资产范围");
      return;
    }
    setBusy(true);
    try {
      const res = await api.addCompanyScope(company.id, parsedScope.rules, reason);
      const errCount = res.invalid ?? 0;
      if (errCount > 0) toast.warning(`已保存；${errCount} 行无效`);
      else toast.success(`已追加 ${res.added} 条范围`);
      showScopeWarnings(res.warnings);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(`保存失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">
          追加
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>追加资产范围 · {company.name}</DialogTitle>
          <DialogDescription>新范围会追加到现有范围。ICP 精确匹配资产，企业关键词仅作为 Agent 提示。</DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-2">
          <ScopeTextEditor
            id={`append-company-scope-${company.id}`}
            value={scopeText}
            onValueChange={setScopeText}
            parsed={parsedScope}
          />
          <Field>
            <FieldLabel htmlFor="as-reason">归属依据（可选）</FieldLabel>
            <Input
              id="as-reason"
              placeholder="如 证书 / whois / ASN 佐证"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || parsedScope.rules.length === 0 || parsedScope.errors.length > 0}>
            {busy ? "保存中…" : "追加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { getCoreRowModel, getSortedRowModel, useReactTable, type Row } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import type { Device, InventorySnapshot } from "@/lib/ipc";
import { useInventoryTable } from "@/stores/inventoryTable";
import { DeviceContextMenu } from "./DeviceMenu";
import { DeviceTypeIcon } from "./DeviceTypeIcon";
import { usesLegacySsh } from "./model";
import { groupKey, groupRows, type ListItem } from "./query";
import { useColumns } from "./columns";

const ROW_HEIGHT = 36;
const GROUP_HEIGHT = 32;
const DOUBLE_CLICK_MS = 220;

interface DevicesTableProps {
  devices: Device[];
  snapshot: InventorySnapshot;
  onOpen: (device: Device) => void;
  onConnect: (device: Device) => void;
}

/** Linear-style device list: sortable, groupable, virtualized, keyboard navigable. */
export function DevicesTable({ devices, snapshot, onOpen, onConnect }: DevicesTableProps) {
  const sorting = useInventoryTable((s) => s.sorting);
  const columnVisibility = useInventoryTable((s) => s.columns);
  const groupBy = useInventoryTable((s) => s.groupBy);
  const collapsed = useInventoryTable((s) => s.collapsed);
  const setTable = useInventoryTable((s) => s.set);
  const toggleGroup = useInventoryTable((s) => s.toggleGroup);
  const columns = useColumns(snapshot);

  // TanStack Table returns non-memoizable functions; the React Compiler skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: devices,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: (u) => setTable({ sorting: typeof u === "function" ? u(sorting) : u }),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (d) => String(d.id),
  });

  const rows = table.getRowModel().rows;
  const items: ListItem<Row<Device>>[] = useMemo(
    () =>
      groupRows(rows, (r) => groupKey(r.original, groupBy, snapshot), groupBy, new Set(collapsed)),
    [rows, groupBy, snapshot, collapsed],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 12,
    // Without layout (tests, first paint) render a screenful instead of nothing.
    initialRect: { width: 1200, height: 800 },
  });

  const [focused, setFocused] = useState(0);
  // A click opens details only if no second click (connect) follows.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const leafColumns = table.getVisibleLeafColumns();
  const totalWidth = leafColumns.reduce((n, c) => n + c.getSize(), 0) + 40;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    e.preventDefault();
    if (e.key === "Enter") {
      const item = items[focused];
      if (item?.kind === "row") onOpen(item.row.original);
      else if (item?.kind === "group") toggleGroup(item.key);
      return;
    }
    const next = Math.max(
      0,
      Math.min(items.length - 1, focused + (e.key === "ArrowDown" ? 1 : -1)),
    );
    setFocused(next);
    virtualizer.scrollToIndex(next);
  }

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Devices"
      aria-rowcount={rows.length}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative min-h-0 flex-1 overflow-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      <div style={{ minWidth: totalWidth }}>
        <div
          role="row"
          className="sticky top-0 z-10 flex h-8 items-center border-b border-border bg-surface px-4 text-xs text-fg-muted"
        >
          <span className="w-6 shrink-0" />
          {table.getHeaderGroups()[0]?.headers.map((h) => {
            const sorted = h.column.getIsSorted();
            return (
              <button
                key={h.id}
                type="button"
                role="columnheader"
                aria-sort={
                  sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                }
                onClick={h.column.getToggleSortingHandler()}
                style={{ width: h.getSize() }}
                className="flex shrink-0 items-center gap-1 truncate pr-3 text-left font-medium hover:text-fg"
              >
                {String(h.column.columnDef.header)}
                {sorted === "asc" && <ArrowUp size={12} />}
                {sorted === "desc" && <ArrowDown size={12} />}
              </button>
            );
          })}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = items[v.index];
            if (!item) return null;
            const style = {
              position: "absolute" as const,
              top: 0,
              left: 0,
              right: 0,
              height: v.size,
              transform: `translateY(${v.start}px)`,
            };
            const isFocused = v.index === focused;
            if (item.kind === "group") {
              return (
                <button
                  key={`g-${item.key}`}
                  type="button"
                  style={style}
                  aria-expanded={!item.collapsed}
                  onClick={() => toggleGroup(item.key)}
                  className={cn(
                    "flex items-center gap-2 border-b border-border bg-surface-raised/50 px-4 text-xs font-medium text-fg-muted",
                    isFocused && "bg-accent-subtle",
                  )}
                >
                  <ChevronRight
                    size={12}
                    className={cn(
                      "transition-transform duration-150",
                      !item.collapsed && "rotate-90",
                    )}
                  />
                  {item.key}
                  <span className="text-fg-subtle">{item.count}</span>
                </button>
              );
            }
            const d = item.row.original;
            return (
              <DeviceContextMenu key={d.id} device={d}>
                <div
                  role="row"
                  aria-selected={isFocused}
                  style={style}
                  onClick={() => {
                    setFocused(v.index);
                    clearTimeout(clickTimer.current);
                    clickTimer.current = setTimeout(() => onOpen(d), DOUBLE_CLICK_MS);
                  }}
                  onDoubleClick={() => {
                    clearTimeout(clickTimer.current);
                    onConnect(d);
                  }}
                  className={cn(
                    "flex cursor-default items-center border-b border-border/60 px-4 text-[13px] transition-colors duration-100 hover:bg-surface-raised",
                    isFocused && "bg-accent-subtle hover:bg-accent-subtle",
                  )}
                >
                  <span className="flex w-6 shrink-0 text-fg-muted">
                    <DeviceTypeIcon type={d.deviceType} size={14} />
                  </span>
                  {item.row.getVisibleCells().map((cell) => (
                    <span
                      key={cell.id}
                      role="gridcell"
                      style={{ width: cell.column.getSize() }}
                      className={cn(
                        "shrink-0 truncate pr-3",
                        cell.column.id === "hostname" && "font-medium",
                        cell.column.id === "mgmtIp" && "font-mono text-xs",
                        cell.column.id !== "hostname" && "text-fg-muted",
                      )}
                      title={String(cell.getValue() ?? "")}
                    >
                      {String(cell.getValue() ?? "")}
                      {cell.column.id === "hostname" && usesLegacySsh(d) && (
                        <span
                          title="Uses legacy SSH algorithms"
                          className="ml-2 rounded-sm bg-warning/20 px-1 text-[11px] font-normal text-warning"
                        >
                          legacy
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </DeviceContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function getGroupLayout(count: number, height: number, width: number) {
  const availableHeight = Math.max(0, height);
  const capacity = Math.max(1, Math.floor((availableHeight + 4) / 56));
  const maxColumns = Math.max(1, Math.floor(width / 64));
  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(count / capacity)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const gap = Math.min(4, availableHeight / (rows * 2));
  const rowHeight = Math.max(0, Math.min(52, (availableHeight - gap * (rows - 1)) / rows));
  return { columns, rows, gap, rowHeight, compact: columns > 1 || rowHeight < 44 };
}

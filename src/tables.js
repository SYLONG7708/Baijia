const TABLE_GROUPS = [
  {
    name: "百家樂",
    key: "baccarat",
    codes: ["B601", "B602", "B603", "B604", "B605", "B201", "B202", "B203"]
  },
  {
    name: "快速百家樂",
    key: "quick",
    codes: ["Q501", "Q502", "Q601", "Q701", "Q702", "Q201", "Q202", "Q204"]
  },
  {
    name: "經典百家樂",
    key: "classic",
    codes: ["B618", "B219", "B220"]
  },
  {
    name: "性感百家樂",
    key: "sexy",
    codes: ["B501", "B502", "B503", "B504", "B505", "B506", "B507"]
  },
  {
    name: "咪排百家樂",
    key: "see-card",
    codes: ["C501", "C701", "C201", "C202"]
  }
];

const TARGET_TABLES = TABLE_GROUPS.flatMap((group) =>
  group.codes.map((code) => ({
    code,
    category: group.name,
    groupKey: group.key,
    label: `${group.name} ${code}`
  }))
);

const TABLE_BY_CODE = new Map(TARGET_TABLES.map((table) => [table.code, table]));
const TARGET_CODES = new Set(TARGET_TABLES.map((table) => table.code));

function normalizeTableCode(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toUpperCase();
}

function isTargetTable(value) {
  return TARGET_CODES.has(normalizeTableCode(value));
}

function tableMeta(value) {
  const code = normalizeTableCode(value);
  return TABLE_BY_CODE.get(code) || {
    code,
    category: "其他",
    groupKey: "other",
    label: code
  };
}

module.exports = {
  TABLE_GROUPS,
  TARGET_TABLES,
  TARGET_CODES,
  normalizeTableCode,
  isTargetTable,
  tableMeta
};

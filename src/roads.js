function resultColor(outcome) {
  if (outcome === "BANKER") return "BANKER";
  if (outcome === "PLAYER") return "PLAYER";
  return "TIE";
}

function gridSet(grid, x, y, value) {
  if (!grid[x]) grid[x] = [];
  grid[x][y] = value;
}

function gridGet(grid, x, y) {
  return grid[x]?.[y];
}

function columnHeight(grid, x) {
  const column = grid[x] || [];
  let count = 0;
  for (let y = 0; y < column.length; y += 1) {
    if (column[y]) count += 1;
  }
  return count;
}

function toPoints(grid) {
  const points = [];
  for (let x = 0; x < grid.length; x += 1) {
    const column = grid[x] || [];
    for (let y = 0; y < column.length; y += 1) {
      if (column[y]) points.push({ x, y, ...column[y] });
    }
  }
  return points;
}

function buildBeadRoad(rounds) {
  return rounds.map((round, index) => ({
    x: Math.floor(index / 6),
    y: index % 6,
    outcome: resultColor(round.outcome),
    roundNo: round.roundNo,
    bankerPair: round.bankerPair,
    playerPair: round.playerPair,
    luckySix: round.luckySix
  }));
}

function buildBigRoad(rounds) {
  const grid = [];
  let lastSide = "";
  let x = 0;
  let y = 0;

  for (const round of rounds) {
    const side = resultColor(round.outcome);
    if (side === "TIE") {
      const target = gridGet(grid, x, y) || gridGet(grid, 0, 0);
      if (target) target.tie = (target.tie || 0) + 1;
      else gridSet(grid, 0, 0, { outcome: "TIE", tie: 1, roundNo: round.roundNo });
      continue;
    }

    if (!lastSide) {
      x = 0;
      y = 0;
    } else if (side === lastSide) {
      const nextY = y + 1;
      if (nextY < 6 && !gridGet(grid, x, nextY)) {
        y = nextY;
      } else {
        x += 1;
      }
    } else {
      x += 1;
      y = 0;
    }

    gridSet(grid, x, y, {
      outcome: side,
      roundNo: round.roundNo,
      bankerPair: round.bankerPair,
      playerPair: round.playerPair,
      luckySix: round.luckySix
    });
    lastSide = side;
  }

  return { grid, points: toPoints(grid) };
}

function derivedColor(bigGrid, x, y, offset) {
  if (x < offset) return null;
  if (y === 0) {
    if (x - offset - 1 < 0) return null;
    return columnHeight(bigGrid, x - 1) === columnHeight(bigGrid, x - offset - 1) ? "R" : "B";
  }
  return Boolean(gridGet(bigGrid, x - offset, y)) === Boolean(gridGet(bigGrid, x - offset, y - 1))
    ? "R"
    : "B";
}

function buildDerivedRoad(bigPoints, bigGrid, offset) {
  const grid = [];
  let last = "";
  let x = 0;
  let y = 0;

  for (const point of bigPoints) {
    const color = derivedColor(bigGrid, point.x, point.y, offset);
    if (!color) continue;

    if (!last) {
      x = 0;
      y = 0;
    } else if (color === last) {
      const nextY = y + 1;
      if (nextY < 6 && !gridGet(grid, x, nextY)) {
        y = nextY;
      } else {
        x += 1;
      }
    } else {
      x += 1;
      y = 0;
    }

    gridSet(grid, x, y, { color, sourceX: point.x, sourceY: point.y });
    last = color;
  }

  return toPoints(grid);
}

function buildRoads(rounds) {
  const sorted = [...rounds].sort((a, b) => a.id - b.id);
  const bead = buildBeadRoad(sorted);
  const big = buildBigRoad(sorted);
  return {
    bead,
    big: big.points,
    bigEye: buildDerivedRoad(big.points, big.grid, 1),
    small: buildDerivedRoad(big.points, big.grid, 2),
    cockroach: buildDerivedRoad(big.points, big.grid, 3)
  };
}

module.exports = {
  buildRoads
};

/**
 * Battle lab CLI.
 *
 *   pnpm lab list
 *   pnpm lab run [--scenario id|all] [--battles 1000] [--seed 1] [--params file.json] [--out dir]
 *   pnpm lab calibrate [--scenario balanced-small] [--target 0.5] [--battles 200]
 *   pnpm lab matchups [--battles 50]
 *
 * Every battle is reproducible from (scenario, seed, params). Results are
 * printed as a table and written as JSON for later comparison.
 */
import { DEFAULT_PARAMS, mergeParams } from '@tio/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrateDamage, matchupMatrix, type Metrics, runScenario } from './run';
import { scenario, SCENARIOS } from './scenarios';

const [cmd = 'run', ...rest] = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1]! : dflt;
};
const paramsFile = opt('params', '');
const params = paramsFile ? mergeParams(DEFAULT_PARAMS, JSON.parse(readFileSync(paramsFile, 'utf8'))) : DEFAULT_PARAMS;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);

function printTable(rows: Metrics[]): void {
  console.log(
    'scenario'.padEnd(22),
    'att.win',
    ' att.cas(p10/med/p90) ',
    ' def.cas(p10/med/p90) ',
    'power A/D',
    ' ms/battle',
  );
  for (const m of rows) {
    console.log(
      m.scenario.padEnd(22),
      pct(m.attackerWinRate),
      ` ${pct(m.casualties.attacker.p10)}${pct(m.casualties.attacker.median)}${pct(m.casualties.attacker.p90)}`,
      ` ${pct(m.casualties.defender.p10)}${pct(m.casualties.defender.median)}${pct(m.casualties.defender.p90)}`,
      Number.isFinite(m.survivingPowerRatio.median) ? m.survivingPowerRatio.median.toFixed(2).padStart(9) : '      inf',
      m.msPerBattle.toFixed(2).padStart(10),
    );
  }
}

switch (cmd) {
  case 'list':
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(22)} ${s.description}`);
    break;
  case 'run': {
    const id = opt('scenario', 'all');
    const battles = Number(opt('battles', '1000'));
    const seed = Number(opt('seed', '1'));
    const list = id === 'all' ? SCENARIOS : [scenario(id)];
    const rows = list.map((s) => runScenario(s, battles, seed, params));
    printTable(rows);
    const out = opt('out', 'lab-output');
    mkdirSync(out, { recursive: true });
    const file = join(out, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({ params: params.combat, units: params.units, results: rows }, null, 2));
    console.log(`\n${list.length * battles} battles; results in ${file}`);
    break;
  }
  case 'calibrate': {
    const sc = scenario(opt('scenario', 'balanced-small'));
    const target = Number(opt('target', '0.5'));
    const r = calibrateDamage(sc, params, target, Number(opt('battles', '200')), Number(opt('seed', '1')));
    console.log(
      `combat.damagePerAttackPerRound ≈ ${r.damagePerAttackPerRound.toPrecision(4)} gives median casualties ${pct(r.median)} in ${sc.id}`,
    );
    break;
  }
  case 'matchups': {
    const m = matchupMatrix(params, Number(opt('battles', '50')));
    const types = Object.keys(m);
    console.log('attacker win rate at equal power (rows attack columns)\n');
    console.log(''.padEnd(12), ...types.map((t) => t.padStart(10)));
    for (const a of types) console.log(a.padEnd(12), ...types.map((d) => pct(m[a]![d]!).padStart(10)));
    break;
  }
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}

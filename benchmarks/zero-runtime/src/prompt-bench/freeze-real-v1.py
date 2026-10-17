"""Freeze selected ZeRo history as a local-only, checksummed replay suite. No model calls."""
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / '.zero/benchmarks/real-replay-fixtures-v1-20260906'
MANIFEST = ROOT / 'benchmarks/zero-runtime/fixtures/prompt-bench/real-replay-v1.manifest.json'
if OUT.exists() or MANIFEST.exists():
    raise SystemExit('Frozen output exists; create a new version rather than overwriting it')
DB = sqlite3.connect('file:' + str(ROOT / '.zero/logs/sessions.db') + '?mode=ro', uri=True)
DB.execute('BEGIN')
provenance = []

def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()

def source(sid, indexes):
    raw = DB.execute('select messages_json from session_messages where session_id=?', (sid,)).fetchone()[0]
    messages = json.loads(raw)
    provenance.append({'sessionId': sid, 'messagesSha256': sha(raw), 'messages': [{'index': i, 'id': messages[i]['id']} for i in indexes]})
    return messages

def text(message):
    return '\n'.join(b.get('text', '') for b in message['content'] if b['type'] == 'text')

def case(id, title, prompt, files, output=None, gold=None, **extra):
    result = dict(id=id, title=title, mode='full', prompt=prompt, files=files,
                  allowedEffects=[f'write:{output}'] if output else [],
                  requiredEffects=[f'write:{output}'] if output else [], requiredFacts=[])
    if output:
        result['expectedFiles'] = [{'path': output, 'content': json.dumps(gold, ensure_ascii=False)}]
    result.update(extra)
    return result

novel_sid = 'sess_20260904_0851_fei_f6e6'
novel = source(novel_sid, [217, 218, 219, 235, 236, 245])
filename = '从骑奴到大乾武圣_第1-244章.txt'
original = ROOT / '.zero/workspace/shared' / filename
book = original.read_text()
heads = list(re.finditer(r'^第\s*(\d+)\s*章[^\n]*', book, re.M))
chapters = []
periods = {}
for i, head in enumerate(heads):
    chapter = int(head[1])
    if chapter not in [112, 113, 115]:
        continue
    body = book[head.end():heads[i + 1].start() if i + 1 < len(heads) else len(book)]
    paragraphs = [line.strip() for line in body.splitlines() if line.strip()]
    # Independent exact period computation; no historical assistant answer used as gold.
    unit = next(n for n in range(1, len(paragraphs) + 1)
                if len(paragraphs) % n == 0 and paragraphs == paragraphs[:n] * (len(paragraphs) // n))
    periods[chapter] = len(paragraphs) // unit
    chapters.append({'chapter': chapter, 'paragraphs': paragraphs})
assert periods == {112: 3, 113: 1, 115: 3}, periods
provenance.append({'artifact': str(original.relative_to(ROOT)), 'sha256': sha(original.read_bytes()),
                   'transform': 'Extract chapters 112, 113 and 115 only, trim blank lines; preserve paragraph text and order.',
                   'goldMethod': 'Smallest exact paragraph-list period; negative control chapter 113.', 'periods': periods})

workbook_sid = 'sess_20260901_1906_fei_c92d'
workbook_messages = source(workbook_sid, [0, 1, 3, 4, 9, 10, 11, 13])
workbook = ROOT / '.zero/workspace/zero-web-auto/uploads/1788260790207_工程提效讨论_20260831.xlsx'
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(workbook) as z:
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        strings = [''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    grid = {}
    for c in sheet.findall('.//s:sheetData/s:row/s:c', ns):
        typ = c.get('t'); v = c.find('s:v', ns)
        value = ''.join(c.find('s:is', ns).itertext()) if typ == 'inlineStr' else (v.text if v is not None else None)
        if typ == 's' and value is not None:
            value = strings[int(value)]
        grid[c.get('r')] = value
    merges = [m.get('ref') for m in sheet.findall('.//s:mergeCell', ns)]
# Ground truth comes from original worksheet cells; merged stages are propagated for counting.
rows = []; stage = None
for r in range(2, 24):
    stage = grid.get(f'B{r}') or stage
    rows.append({'id': int(grid[f'A{r}']), 'stage': stage, 'description': grid.get(f'D{r}'), 'status': grid.get(f'F{r}') or None})
counts = collections.Counter(row['status'] or '未填写' for row in rows)
stages = collections.Counter(row['stage'] for row in rows)
assert len(rows) == 22
assert dict(counts) == {'暂不考虑': 11, '计划更新': 8, '未填写': 1, '计划做': 2}, counts
workbook_gold = {'total': len(rows), 'byStatus': dict(counts), 'byStage': dict(stages),
                 'plannedIds': [row['id'] for row in rows if row['status'] == '计划做'],
                 'unspecifiedIds': [row['id'] for row in rows if row['status'] is None]}
provenance.append({'artifact': str(workbook.relative_to(ROOT)), 'sha256': sha(workbook.read_bytes()),
                   'transform': 'Original A/B/D/F cells only, preserve blank merged-stage cells and merge ranges; omit free-text tool details.',
                   'goldMethod': 'Independent XLSX ZIP/XML parse; count original row IDs and status cells; forward fill merged stages.'})
worksheet = {'sheet': 'Sheet1', 'columns': {'A': '序号', 'B': '工作阶段', 'D': '工作描述', 'F': '结论'},
             'rows': [{col: grid.get(f'{col}{r}') for col in ['A', 'B', 'D', 'F']} for r in range(2, 24)], 'mergedRanges': merges}

game_sid = 'sess_20260726_0056_fei_8726'
game = source(game_sid, [0, 3, 4, 6])
path = '/benchmark/shared/' + filename
agents = [
    case('real-file-path', '历史 TXT 文件路径定位',
         text(novel[217]) + '\n交付历史已冻结在 /benchmark/delivery.txt；本次只回答路径，不重新下载或发送。',
         {'/benchmark/delivery.txt': text(novel[218]).replace('/Users/v1ki/Desktop/test4_zero/.zero/workspace/shared/', '/benchmark/shared/')},
         requiredFacts=[[path]], requiredTools=['read:/benchmark/delivery.txt'], strictReadOnly=True),
    case('real-game-steering', '接收用户对开源编程游戏的名称纠正',
         text(game[0]) + '\n' + text(game[3]) + '\n请先读取 /benchmark/previous-answer.txt 中此前的候选回复，再判断。为便于核对，最终写入 /benchmark/game.json，格式仅为 {"bestMatch":"游戏名称"}，表达当前最可能的匹配。',
         {'/benchmark/previous-answer.txt': text(game[4])},
         '/benchmark/game.json', {'bestMatch': 'Screeps'},
         requiredTools=['read:/benchmark/previous-answer.txt'],
         followUp={'afterTool': 'read', 'path': '/benchmark/previous-answer.txt', 'prompt': text(game[6])}),
    case('real-workbook-summary', '真实工程提效表的状态和阶段汇总',
         '看看这个工程提效表里面讲了什么。原始工作簿的单元格已导出到 /benchmark/workbook.json，保留了合并单元格信息。请读取并写 /benchmark/summary.json，字段严格为 total（条目数）、byStatus（结论到数量，空结论键为“未填写”）、byStage（工作阶段到数量）、plannedIds（结论为“计划做”的序号升序）、unspecifiedIds（空结论序号升序）。合并的阶段单元格沿用上方阶段。最后用中文概括。不要把“计划更新”当成“计划做”。',
         {'/benchmark/workbook.json': json.dumps(worksheet, ensure_ascii=False)},
         '/benchmark/summary.json', workbook_gold, requiredTools=['read:/benchmark/workbook.json']),
    case('real-intrachapter-duplication', '真实 TXT 章内三重重复及正常章节负例',
         text(novel[219]) + '\n' + text(novel[236]) + '\n原 TXT 的第112、113、115章已按原顺序提取为 /benchmark/chapters.json 的段落数组。请检查这些章节是否存在“整篇正文作为连续完整块重复”的问题，不要仅检查章节号或跨章相同，也不要把正常短句/情节复述当作整篇重复。将结果写入 /benchmark/duplicates.json，字段严格为 repeatedChapters（章号升序）、copies（重复章号字符串到完整正文出现次数，包含第一份）、unaffectedChapters（未整篇重复章号升序）。不改原文。',
         {'/benchmark/chapters.json': json.dumps(chapters, ensure_ascii=False)},
         '/benchmark/duplicates.json', {'repeatedChapters': [n for n, copies in periods.items() if copies > 1],
                                      'copies': {str(n): copies for n, copies in periods.items() if copies > 1},
                                      'unaffectedChapters': [n for n, copies in periods.items() if copies == 1]},
         requiredTools=['read:/benchmark/chapters.json']),
]
closures = [
    dict(id='closure-real-io-complete', title='真实双问题均已回答：完整上下文应收尾',
         user=text(workbook_messages[9]), queued=text(workbook_messages[10]),
         assistant='已向用户发送的两段答复，按时间先后：\n' + text(workbook_messages[11]) + '\n\n' + text(workbook_messages[13]),
         tools='两段答复已经向用户发送；没有待执行工具，没有其他未完成事项。', expected='finish'),
    dict(id='closure-real-io-truncated', title='只给最近 IO 答复：原始工程提效问题仍缺答复证据',
         user=text(workbook_messages[9]), queued=text(workbook_messages[10]),
         assistant=text(workbook_messages[13]),
         tools='本判定输入只提供当前答复；没有原始工程提效定义已回答的证据。', expected='continue'),
]
provenance.append({'replayLimitations': ['Real historical text and worksheet/novel extracts with normalized output contracts; not full original sessions.',
                   'No live browser, database writes, document conversion, file sending or publisher actions.',
                   'Closure probes deliberately compare available evidence; truncated input is a context diagnostic, not a model failure.',
                   'All cases reviewed during selection; this is calibration, not an unseen holdout score.']})
suite = {'schema': 1, 'agent': agents, 'closure': closures, 'provenance': provenance}
raw = json.dumps(suite, ensure_ascii=False, indent=2) + '\n'
# Keep original content in ignored local operational output, not source-controlled fixtures.
OUT.mkdir(mode=0o700)
with (OUT / 'suite.json').open('x') as f:
    f.write(raw)
os.chmod(OUT / 'suite.json', 0o600)
with MANIFEST.open('x') as f:
    json.dump({'schema': 1, 'file': os.path.relpath(OUT / 'suite.json', MANIFEST.parent), 'sha256': sha(raw),
               'caseIds': [x['id'] for x in agents + closures], 'origin': 'zero-session-replay',
               'preflight': {'worksheetRows': len(rows), 'statusCounts': dict(counts), 'chapterCopies': periods}}, f, ensure_ascii=False, indent=2)
    f.write('\n')
DB.close()
print(json.dumps({'cases': len(agents) + len(closures), 'suiteSha256': sha(raw), 'workbookGold': workbook_gold,
                  'chapterCopies': periods, 'chapterInputChars': len(agents[-1]['files']['/benchmark/chapters.json'])}, ensure_ascii=False))

# Локальный сравнительный анализ Warcraft Logs

Расширение [vinylflamingo/wcl-mcp](https://github.com/vinylflamingo/wcl-mcp) (MIT), upstream `6d9bf54ec5194a016a0e2aa92e1502f3318bfb14`. TypeScript/Node.js, файловый архив, CLI и stdio MCP. Codex исследует данные и пишет разбор по-русски; отдельный LLM API не нужен.

Для агента: [подготовка нового клона](docs/agent-setup.md). Сравнение оформляется в HTML с иконками способностей, отдельными разделами о бурстах и ротации вне бурстов и временем без миллисекунд: [требования к отчёту](docs/analysis-template.md). Единицы API и архива остаются прежними.

## Установка и первый запуск

Node.js 22.12+ и npm:

```bash
npm ci
cp .env.example .env
# Заполните .env локально; не отправляйте секреты в чат.
npm run build
npm test
```

Зарегистрируйте API client на [Warcraft Logs](https://www.warcraftlogs.com/api/clients/). Для публичных отчётов используется [документированный client credentials flow](https://www.warcraftlogs.com/api/docs): POST /oauth/token, затем Bearer token в /api/v2/client. Приватные отчёты и пользовательский OAuth не поддерживаются.

В `.env` нужны `WCL_CLIENT_ID` и `WCL_CLIENT_SECRET`. Файл загружается относительно проекта, даже когда Codex запускает сервер с другим cwd. Токены хранятся только в памяти. Без credentials локальный inspect/compare работает, сетевые операции дают понятную ошибку.

Первый отчёт и поиск Морано:

```bash
node dist/cli.js '{"action":"list","report":"dVaGXbfj6DCHPBFN","name":"Морано"}'
node dist/cli.js '{"action":"download","report":"https://ru.warcraftlogs.com/reports/dVaGXbfj6DCHPBFN?fight=last","fight":"last"}'
```

`last` выбирает последний encounter, включая wipe. Ответ содержит точный fight.id и directory. Запомните fight ID и actor ID из list. Далее замените 1/123 ниже фактическими ID:

```bash
node dist/cli.js '{"action":"inspect","query":{"report":"dVaGXbfj6DCHPBFN","fight":1,"actor_id":123,"view":"setup","limit":20}}'
node dist/cli.js '{"action":"inspect","query":{"report":"dVaGXbfj6DCHPBFN","fight":1,"actor_id":123,"direction":"source","view":"casts","start_ms":0,"end_ms":30000,"limit":50}}'
node dist/cli.js '{"action":"inspect","query":{"report":"dVaGXbfj6DCHPBFN","fight":1,"actor_id":123,"view":"summary","limit":50}}'
node dist/cli.js '{"action":"inspect","query":{"report":"dVaGXbfj6DCHPBFN","fight":1,"actor_id":123,"direction":"target","view":"buffs","limit":50,"offset":0}}'
```

После предоставления референса: list → download его боя → compare. Например (ID и report заменяются фактическими):

```bash
node dist/cli.js '{"action":"compare","left":{"report":"dVaGXbfj6DCHPBFN","fight":1,"actor_id":123,"view":"casts","start_ms":10000,"end_ms":30000,"limit":30},"right":{"report":"REFERENCECODE123","fight":2,"actor_id":456,"view":"casts","start_ms":15000,"end_ms":35000,"limit":30}}'
```

Выберите start_ms отдельно по началу бурста/фазы. `windowMs` отсчитывается от start_ms каждой стороны. Для сравнения всего боя опустите временные границы, view=summary. Сравнение возвращает две доказательные выборки и контекст; семантические выводы делает Codex.

## Подключение MCP к Codex

По [актуальной официальной документации Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) (проверено 23.10.2026) локальный сервер регистрируется командой:

```bash
codex mcp add warcraftlogs -- node /absolute/path/to/wow-log-analyzer/dist/index.js
```

Либо добавьте в `~/.codex/config.toml` (путь к node должен быть доступен GUI-приложению; при необходимости укажите абсолютный результат `which node`):

```toml
[mcp_servers.warcraftlogs]
command = "node"
args = ["/absolute/path/to/wow-log-analyzer/dist/index.js"]
env = { WCL_DATA_DIR = "/absolute/path/to/wow-log-analyzer/data" }
```

Credentials сервер прочитает из проектного `.env`, передавать их в config не требуется. `WCL_DATA_DIR` по умолчанию — data рядом с проектом. После подключения начните новый чат с этим проектом, проверьте наличие `local_analysis`. Конфигурация пользователю автоматически не изменялась. Проверка документации и stdio handshake не означают, что сервер уже подключён к вашему чату.

## MCP и CLI

Один новый MCP-инструмент `local_analysis` принимает те же JSON, что CLI:

| action | Назначение |
|---|---|
| list | Метаданные, пагинированные fights и actors; name — точное имя без учёта регистра |
| download | Весь бой: All events для Friendlies и Enemies, includeResources, без source/target фильтра; все страницы |
| inspect | query с report/fight, view=events/casts/buffs/summary/setup/abilities |
| compare | Независимые left/right query для двух боёв или окон |

В query: actor_id, direction=either/source/target (по умолчанию either), ability_id, types (точные raw event types), start_ms/end_ms, offset, limit=1..200. Интервал [start_ms,end_ms), время в миллисекундах относительно начала боя. casts включает begincast/cast/interrupt; buffs содержит изменения стаков. summary группирует event type, spell ID, source/target, считает количество, logged amount и наблюдаемые интервалы аур. Для исходящего урона/кастов используйте source, для полученных бафов — target. Питомцы доступны по petOwner; их actor_id запрашиваются отдельно.

Все 13 upstream MCP-инструментов, ресурсы и prompts сохранены. `get_fight_events` теперь использует полный архив и имеет offset/limit; legacy source_name/target_name сохранены. Для корректной двунаправленной выборки предпочтителен local_analysis. Старые агрегатные инструменты работают через API, не через локальный архив.

Ответы ограничены 60 KB; массивы — 200 строками и 24 KB. `next_offset` продолжает выборку; `oversized_item` или `response_too_large` требует уменьшения окна/limit либо чтения конкретного файла. Большой ответ не отправляется в контекст целиком.

## Хранение и полнота

`data/<report>/<fight>/` (исключён из Git):

- metadata.json — report, fights, phaseTransitions, акторы/питомцы, справочник abilities;
- setup.json — исходный playerDetails с includeCombatantInfo, если API вернул;
- page-Friendlies-N.json / page-Enemies-N.json — параметры страницы и исходные GraphQL data; оригинальные события не изменены;
- events.jsonl — производные события с исходным timestamp и добавленным relativeMs;
- manifest.json — query/параметры, дата, границы, units, страницы, события, cursor, complete и warnings.

`complete=true` только после nextPageTimestamp=null. Оба потока hostility проходят до null; их объединение сохраняет максимальную кратность одинаковых событий, удаляя только пересечение потоков. Пустая страница с курсором не завершает загрузку. Курсор должен продвигаться и оставаться в границах. Лимит страниц/ошибка → complete=false, CLI exit 2. При жёстком завершении сохранённый manifest остаётся false. Повторный запуск неполного архива начинает загрузку заново; завершённый numeric fight переиспользуется без сети. `last` сначала заново разрешается через API. Для обновления завершённого архива переместите его папку и повторите download.

Одновременно загружайте конкретный бой только одним процессом. Файловая блокировка/возобновление с середины и валидация целостности дискового кэша пока не реализованы. Архив отражает ответы API на момент загрузки; не гарантирует, что исходный combat log содержит все возможные данные. Квота/HTTP rate limits: до трёх повторов, Retry-After (seconds/date), timeout 30s, обновление 401. Ошибки GraphQL возвращаются явно; quota errors в GraphQL не повторяются автоматически.

## Проверки и ограничения

`npm test` — unit, включая небольшие **синтетические** fixtures (не реальный бой); `npm run test:integration` — upstream live suite другого персонажа, требует credentials. Первый реальный пользовательский e2e — две команды list/download выше, затем setup для Морано. Проверка реального отчёта и результаты описаны в docs/live-verification.md. Для повторной проверки локального архива: `node scripts/verify-archive.mjs REPORT FIGHT ACTOR`. Скрипт не обращается к API и не читает credentials.

Таланты, hero talents, характеристики, gear и spec сохраняются, только если присутствуют в playerDetails/combatantinfo. Отсутствующие поля недоступны. Начальные бафы/неполные интервалы и каналы не восстанавливаются; uptime наблюдаемый, а не гарантированно точный. Поле Report.gameVersion в живой схеме не поддерживается, поэтому возвращается null; точный patch/build недоступен в метаданных текущего загрузчика. Движок ротации, автоматическая оценка потерянного DPS, поиск топов, UI и облако отсутствуют. Оконные выборки читают JSONL потоком, однако объединение потоков, отобранные события и агрегаты пока собираются в памяти; для исследования сужайте окна.

[Аудит основы](docs/upstream-audit.md), [правила анализа](AGENTS.md), [шаблон разбора](docs/analysis-template.md).

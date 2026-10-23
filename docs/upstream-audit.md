# Проверка основы

Основа: https://github.com/vinylflamingo/wcl-mcp, upstream commit `6d9bf54ec5194a016a0e2aa92e1502f3318bfb14`. Изучены README, CLAUDE.md, исходники, package.json, unit/integration tests.

- 13 инструментов, 3 ресурса, 5 prompts; stdio, TypeScript, SDK MCP, zod. graphql-request указан зависимостью, клиент фактически использует fetch.
- get-fight-events исходно делает единственный запрос с limit=500. Возвращает nextPageTimestamp, но входного курсора у инструмента нет; повтор вызова получает ту же страницу. Нет доказательства полноты.
- Фильтры исходно: event_type, source_name/target_name (локально после первой страницы), ability_id; нет временной выборки в интерфейсе. Комментарий о разных пространствах actor IDs не подтверждён кодом тестов; расширение явно включает useActorIDs/useAbilityIDs.
- combatant-info получает Summary table, но форматтер выводит только name/classSpec. Таланты/gear/stats не извлекаются. Расширение сохраняет playerDetails(includeCombatantInfo:true) и combatantinfo без потери полей.
- Кэш LRU 500 — только память. Нет manifest/raw файлов и нормализованного времени.
- Клиент имеет OAuth client credentials, раннее обновление токена, до 3 повторов, 401/429/5xx, circuit breaker. Исходно нет timeout, Retry-After date, GraphQL errors повторяются даже при ошибке схемы; тело ошибки OAuth могло попасть в сообщение. Это исправлено. GraphQL errors теперь немедленно возвращаются; quota reset через GraphQL автоматически не распознаётся.
- Upstream ответы не имели общего ограничения размера. Добавлен общий cap 60 KB; локальные массивы ограничены 200 строками и 24 KB, возможен явный response_too_large.
- Upstream tests: unit форматтеров/кэша/utils; integration рассчитаны на другого персонажа. Для MVP добавлены синтетические fixtures архива. По умолчанию npm test запускает unit; test:integration требует credentials и обращается к персонажу upstream, поэтому первый пользовательский запуск выполняется CLI.
- Статические knowledge/zones upstream не подтверждают текущий сезон и не используются загрузчиком как правила ротации.

Официальная схема: https://www.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html
Документация API/доступа: https://www.warcraftlogs.com/api/docs
В среде разработки прямое открытие WCL docs отвечало 403. Поиск по официальной схеме подтвердил includeResources, useActorIDs/useAbilityIDs и необходимость nextPageTimestamp до null (включая пустую страницу). Синтетические тесты не подтверждают доступность данных конкретного боя.

## Живая проверка

23.10.2026 проверен отчёт 19cgyN2Z6fCJAtDP, fight 20, Марано (actor 3). API отверг Report.gameVersion; запрос исправлен. Размер страницы расширения теперь 10000. Архив полный: 452296 событий, 92 страницы. Подробности: [live-verification.md](live-verification.md).

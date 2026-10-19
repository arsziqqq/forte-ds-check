# Где используется «Spacing semantic»

Коллекция `Spacing semantic` (ключ `b97ef3f2…`) не входит ни в «Tokens ИБ», ни в «NEW ИБ Design System».
Это внешняя библиотека. В файлах ИБ встречаются 2 её версии: старая с режимами `lg, s` и новая с режимами `lg, md, s, xs`.

Переменные: `horizontal/screen-web-margin`, `horizontal/between-sections`, `horizontal/header-between-block`,
`vertical/screen-web-margin`, `vertical/between-forms`, `vertical/between-blocks`, `header/between-primitive`.

## NEW ИБ Design System — компоненты

| Страница | Компонент | Где | Переменная |
|---|---|---|---|
| header | **header** (1:17207) | Toolbar → gap, padding L/R (во всех вариантах) | `horizontal/header-between-block`, `horizontal/screen-web-margin` |
| header | **header** (1:17207) | Buttons → **радиус** всех углов | `vertical/between-forms` — отступ использован как радиус |
| чат | **chat/header** (5048:2105) | padding со всех сторон | `vertical/between-forms` |
| splash screen | **Splash Screen** (2223:6457) | gap | `vertical/screen-web-margin` |
| archive | attach file, chat header, chat background, call buttons, calls, states, share screen, mic, video state, Call participants, share window, letter from | gap, padding и **радиусы** | `vertical/between-forms`, `vertical/screen-web-margin` |

Главное — компонент **header**: он стоит на каждом экране ИБ, поэтому внешние переменные из него
попадают во все макеты (внутри инстанса, это не ошибка дизайнера).

В ДС проверены все страницы с компонентами. На страницах buttons, inputs, tags, chips, controls, back-link, menu, tabs,
progress bar, calendar, snackbar, tooltip, table, status, modal, timeline, text, products, data input,
quick actions, главная, my profile, others и «шаблоны для дизайнеров» эта коллекция не используется.
Не проверялись страницы icons, graphics, qr, guideline, Versions, Backlog и cover.

## Файл «Переводы» — страница «Draft»

Всего 1241 привязка. Из них прямо в макетах (не внутри инстансов) — повторяющийся паттерн:

| Слой | Свойство | Переменная |
|---|---|---|
| «Платежная форма» (обёртка экрана) | gap | `horizontal/between-sections` |
| «Платежная форма» | padding L/R | `horizontal/screen-web-margin` |
| «Платежная форма» | padding T/B | `vertical/screen-web-margin` |
| «Действия по платежке» | gap | `header/between-primitive` |
| «валютный договор фильтр» и вложенные фреймы | padding, gap | `horizontal/between-sections`, `vertical/between-blocks`, `vertical/between-forms`, `vertical/screen-web-margin` |
| «Детали платежа», Frame 2087331608 / 2087331596 / 2087331341 | padding, gap | те же |

Такая обёртка «Платежная форма» есть почти на каждом экране страницы (≈90 экранов: Desktop - 7xx/8xx/10xx,
«Создание перевода в валюте», «1. До расчета», «2. После расчета» и др.). Похоже, её копируют из одного шаблона,
поэтому если поправить шаблон, исправятся сразу все новые экраны.

## Что делать

1. В «Tokens ИБ» добавить семантические отступы (или решить, что достаточно `Space/*`).
2. В ДС перепривязать **header** (Toolbar, Buttons) и **chat/header**, **Splash Screen** на токены ИБ.
   Радиус у Buttons в header привязать к `Radius/*`, а не к отступу.
3. Опубликовать ДС и обновить библиотеку в «Переводах».
4. Плагин Forte DS Check покажет оставшиеся места правилом «Переменная из чужой библиотеки», а его кнопка «Исправить»
   перепривяжет их на `Space/*` с тем же значением.

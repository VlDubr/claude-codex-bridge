// i18n.mjs — тексты, которые видят пользователь и вызываемая модель.
//
// Зачем: плагин писался на русском целиком, включая промпты. Промпт на русском
// заставляет и Codex, и Claude отвечать по-русски, поэтому для нерусскоязычного
// пользователя это был не «плагин с русской документацией», а плагин, меняющий
// язык вывода. Английский стал языком по умолчанию, русский включается
// настройкой.
//
// Здесь только наружные строки. Комментарии в коде остаются русскими: их видит
// автор, а не пользователь.

const LANGS = new Set(["en", "ru"]);

/** Язык интерфейса. Значение вне набора игнорируется — молча падать некуда. */
export function lang() {
  const v = process.env.CODEX_BRIDGE_LANG;
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return LANGS.has(t) ? t : "en";
}

const PROMPTS = {
  en: {
    review: (diff, extra) => `You are acting as a code reviewer. Work read-only: change nothing.

Review the changes below thoroughly. Split your output into:
1. Blockers — things that must not be merged.
2. Important — bugs, holes, races, leaks, unhandled failures.
3. Minor — style, naming, dead code.

For every item give file:line and a concrete suggestion. If the diff alone is not enough, read the files in the repository. Do not praise code that does not deserve it; an empty section beats filler.
${extra ? `\nExtra focus requested by the user: ${extra}\n` : ""}
The context below is split into sections. The "Not committed yet" section holds edits absent from the branch commits: their status differs from the rest, so account for that in your findings. Where a patch is replaced by an instruction to read the files yourself, read them — do not guess.

=== REVIEW CONTEXT ===
${diff || "(no changes found — inspect the working tree yourself)"}`,

    challenge: (diff, focus) => `You are acting as an adversarial reviewer. Your job is not to find typos but to challenge the decision.

Work read-only. Answer:
- Which implicit assumptions are baked into this design, and what happens when they do not hold?
- Which failure mode did the authors not consider? (races, partial rollback, data loss, retries, dependency degradation)
- Is there a fundamentally simpler or safer approach? If so, describe it and state honestly where it is worse.
- What breaks under 100x load or during a release rollback?

Do not agree out of politeness. If the decision is genuinely sound, say so plainly and name the conditions under which it stops being sound.
${focus ? `\nThe user asks you to focus on: ${focus}\n` : ""}
The context below is split into sections. The "Not committed yet" section holds edits absent from the branch commits: their status differs from the rest, so account for that in your findings. Where a patch is replaced by an instruction to read the files yourself, read them — do not guess.

=== REVIEW CONTEXT ===
${diff || "(no changes found — inspect the working tree yourself)"}`,

    delegate: (task) => `A task in this repository has been delegated to you. You may read and change files, run tests and build commands.

TASK:
${task}

How to work:
1. Find the cause, not the symptom. Show what backs the diagnosis.
2. Make the smallest safe change.
3. Check yourself: run the relevant tests or linter if they exist.
4. Finish with a summary: what was wrong, what you changed (list of files), how you verified it, what is still open.

Do not rewrite what nobody asked about. If the task is ambiguous, pick a reasonable reading and name it explicitly in the summary.`,

    ask: (question, context) => `Another model (Claude), working on a task in this repository, is asking you for a second opinion.

${context ? `CONTEXT FROM CLAUDE:\n${context}\n\n` : ""}QUESTION:
${question}

Answer to the point and concisely. You may read repository files to check facts. If you disagree with the premise of the question, say so plainly — that is worth more than polite agreement. Where you are unsure, state your confidence.`,

    chat: (message, context) => `A user is starting a conversation with you through Claude Code: the bridge relays their messages, and you answer as a model in your own right. The conversation continues in this same thread, so keep the context.

${context ? `CONTEXT:\n${context}\n\n` : ""}MESSAGE:
${message}

Answer to the point and concisely. You may read repository files. If the message is ambiguous, ask rather than guess.`,
  },

  ru: {
    review: (diff, extra) => `Ты выступаешь ревьюером кода. Работай только на чтение: ничего не меняй.

Проведи тщательное ревью изменений ниже. Разбей вывод на:
1. Блокеры — то, что нельзя мержить.
2. Важное — баги, дыры, гонки, утечки, неучтённые ошибки.
3. Мелочи — стиль, именование, мёртвый код.

Для каждого пункта дай файл:строку и конкретное предложение. Если что-то непонятно из дифа — прочитай нужные файлы в репозитории. Не хвали код, если хвалить не за что; пустая секция лучше воды.
${extra ? `\nДополнительный фокус от пользователя: ${extra}\n` : ""}
Контекст ниже разбит на разделы. Раздел «Ещё не закоммичено» — правки, которых нет в коммитах ветки: их состояние отличается от остального, учитывай это в замечаниях. Если вместо патча стоит указание дочитать самому — читай файлы, не додумывай.

=== КОНТЕКСТ РЕВЬЮ ===
${diff || "(изменений не найдено — посмотри рабочее дерево сам)"}`,

    challenge: (diff, focus) => `Ты выступаешь состязательным ревьюером. Твоя задача — не найти опечатки, а оспорить решение.

Работай только на чтение. Ответь на:
- Какие неявные допущения зашиты в этот дизайн и что будет, если они не выполнятся?
- Какой сценарий отказа авторы не рассмотрели? (гонки, частичный откат, потеря данных, ретраи, деградация зависимостей)
- Существует ли принципиально более простой или более безопасный подход? Если да — опиши его и честно назови, чем он хуже.
- Что сломается при 100x нагрузке или при откате релиза?

Не соглашайся из вежливости. Если решение действительно хорошее — скажи это прямо и укажи, при каких условиях оно перестанет быть хорошим.
${focus ? `\nПользователь просит сфокусироваться на: ${focus}\n` : ""}
Контекст ниже разбит на разделы. Раздел «Ещё не закоммичено» — правки, которых нет в коммитах ветки: их состояние отличается от остального, учитывай это в замечаниях. Если вместо патча стоит указание дочитать самому — читай файлы, не додумывай.

=== КОНТЕКСТ РЕВЬЮ ===
${diff || "(изменений не найдено — посмотри рабочее дерево сам)"}`,

    delegate: (task) => `Тебе делегирована задача в этом репозитории. Ты можешь читать и изменять файлы, запускать тесты и команды сборки.

ЗАДАЧА:
${task}

Порядок работы:
1. Сначала разберись в причине, а не в симптоме. Покажи, чем подтверждается диагноз.
2. Сделай минимальное безопасное изменение.
3. Проверь себя: запусти релевантные тесты или линтер, если они есть.
4. В конце выдай сводку: что было не так, что изменил (список файлов), как проверил, что осталось незакрытым.

Не переписывай то, о чём не просили. Если задача сформулирована неоднозначно — выбери разумную трактовку и явно назови её в сводке.`,

    ask: (question, context) => `К тебе обращается другая модель (Claude), работающая над задачей в этом репозитории. Она просит второе мнение.

${context ? `КОНТЕКСТ ОТ CLAUDE:\n${context}\n\n` : ""}ВОПРОС:
${question}

Ответь по существу и сжато. Можешь читать файлы репозитория, чтобы проверить факты. Если ты не согласен с посылкой вопроса — скажи об этом прямо, это ценнее вежливого согласия. Если уверенности нет — обозначь степень уверенности.`,

    chat: (message, context) => `С тобой начинает разговор пользователь через Claude Code: его сообщения передаёт мост, а ты отвечаешь как самостоятельная модель. Разговор продолжится в этом же треде, поэтому помни контекст.

${context ? `КОНТЕКСТ:\n${context}\n\n` : ""}СООБЩЕНИЕ:
${message}

Отвечай по существу и сжато. Можешь читать файлы репозитория. Если сообщение неоднозначно — уточни, а не угадывай.`,
  },
};

// Описания инструментов и их параметров. Это первое, что читает модель, решая,
// звать инструмент или нет, поэтому формулировки здесь важнее стилистики.
const TOOLS = {
  en: {
    effort:
      "Reasoning level. The available set depends on the model: codex_models returns the exact list. Only earlier-generation models accept minimal — gpt-5.6 and newer reject it with an API error.",

    ask_d: "Ask GPT (Codex) for a second opinion synchronously and get the answer in this same turn. Use it to sanity-check an architectural decision, test your own hypothesis, or get a counterargument before writing code. Answers within 1-3 minutes.",
    ask_question: "The question for GPT, phrased so it stands on its own.",
    ask_context: "Your current context: what you already found out, what you propose, what you doubt. The more concrete, the more useful the answer.",
    ask_model: "Codex model, e.g. gpt-5.6-sol or gpt-5.4-mini.",
    ask_wait: "How long to wait for a synchronous answer. If Codex does not finish in time the call does not fail: the very same work continues in the same process in the background and a job_id is returned along with the progress trail — follow it with codex_progress.",

    chat_d: "Talk to a Codex model as a separate interlocutor: the thread persists and the model remembers earlier messages. Use it when you need a dialogue rather than a one-off question, or when a specific GPT model is carrying the task.",
    chat_message: "Message for the model.",
    chat_chat: "Conversation name (latin letters, digits, hyphen). One name is one continuous thread. Defaults to default.",
    chat_model: "Codex model for this conversation. Set on the first message and reused automatically afterwards.",
    chat_context: "Extra context for the first message of the conversation.",
    chat_write: "Allow the model to change files in the working directory. Read-only by default.",
    chat_wait: "How long to wait for the answer in this same turn.",

    chats_d: "List conversations with Codex models; a conversation can be forgotten together with its thread.",
    chats_forget: "Name of the conversation to forget.",

    use_d: "Pick the default model and reasoning level for this repository. Applies to later calls that do not name a model explicitly.",
    use_model: "Codex model. An empty string resets to the plugin setting.",
    use_clear: "Reset both the model and the reasoning level.",

    review_d: "Run an ordinary GPT code review of the current changes. Runs in the background by default.",
    review_base: "Base branch for reviewing the whole branch, e.g. main. Branch commits and uncommitted work are collected separately.",
    review_focus: "Optional extra focus.",

    challenge_d: "Adversarial review: GPT challenges a design decision, hunts for failure modes nobody accounted for, and proposes alternatives. Use it before merging a large change.",
    challenge_focus: "What exactly to challenge: 'the retry scheme', 'the cache choice', 'the permission model'.",

    delegate_d:
      "Delegate a task to GPT with permission to change files: investigate a bug, fix a test, refactor a piece. " +
      "Shows the progress trail while it waits; if GPT does not finish in time the work continues in the background and a job_id is returned.",
    delegate_task: "Description of the task for GPT, as concrete as possible.",
    delegate_wait:
      "How long to wait while showing GPT's progress trail. Zero goes to the background immediately and returns a job_id. " +
      "When the time runs out the call does not fail: the very same work continues in the same process.",

    models_d: "Get the list of models actually available in this Codex installation. Asks Codex itself instead of using a hardcoded list. Call this before naming a model in other tools if you are unsure of the name.",
    models_refresh: "Ignore the cache and re-read the catalogue.",

    progress_d: "Show what the model is doing right now: the trail of its reasoning, commands it ran, files it edited, searches it made. Use it instead of waiting blindly when a task runs long.",
    progress_job: "Defaults to the most recent task.",
    progress_limit: "How many of the latest steps to show.",
    progress_detail: "Show reasoning summaries in full.",
    progress_wait: "Wait this many seconds for new events, showing them as they appear.",

    status_d: "Show the status of background Codex tasks for the current repository.",
    status_job: "Optional: a specific task.",

    result_d: "Get the final output of a finished background Codex task.",
    result_job: "Optional: defaults to the most recent task.",
    result_tail: "Return only the last N lines.",

    cancel_d: "Cancel a running background Codex task.",
  },

  ru: {
    effort:
      "Уровень reasoning. Набор зависит от модели: точный список отдаёт codex_models. Значение minimal принимают только модели прошлых поколений — gpt-5.6 и новее отвергают его ошибкой API.",

    ask_d: "Спросить у GPT (Codex) второе мнение синхронно и получить ответ в этом же ходе. Используй, когда нужно сверить архитектурное решение, проверить свою гипотезу или получить контраргумент перед тем, как писать код. Отвечает за 1-3 минуты.",
    ask_question: "Вопрос к GPT, сформулированный самодостаточно.",
    ask_context: "Твой текущий контекст: что ты уже выяснил, какое решение предлагаешь, какие есть сомнения. Чем конкретнее, тем полезнее ответ.",
    ask_model: "Модель Codex, напр. gpt-5.6-sol или gpt-5.4-mini.",
    ask_wait: "Сколько ждать синхронного ответа. Если Codex не успеет, вызов не падает по таймауту: та же самая работа продолжается тем же процессом в фоне и возвращается job_id вместе с лентой прогресса — дальше следи через codex_progress.",

    chat_d: "Поговорить с моделью Codex как с отдельным собеседником: тред сохраняется, модель помнит предыдущие сообщения. Используй, когда нужен диалог, а не одиночный вопрос, или когда задачу ведёт конкретная модель GPT.",
    chat_message: "Сообщение модели.",
    chat_chat: "Имя разговора (латиница, цифры, дефис). Одно имя — один непрерывный тред. По умолчанию default.",
    chat_model: "Модель Codex для этого разговора. Задаётся на первом сообщении и дальше повторяется сама.",
    chat_context: "Дополнительный контекст к первому сообщению разговора.",
    chat_write: "Разрешить модели менять файлы в рабочем каталоге. По умолчанию только чтение.",
    chat_wait: "Сколько ждать ответа в этом же ходе.",

    chats_d: "Список разговоров с моделями Codex; можно забыть разговор вместе с его тредом.",
    chats_forget: "Имя разговора, который надо забыть.",

    use_d: "Выбрать модель и уровень reasoning по умолчанию для этого репозитория. Действует на последующие вызовы, у которых модель не указана явно.",
    use_model: "Модель Codex. Пустая строка — сброс к настройке плагина.",
    use_clear: "Сбросить и модель, и уровень reasoning.",

    review_d: "Запустить обычное ревью кода силами GPT по текущим изменениям. По умолчанию в фоне.",
    review_base: "Базовая ветка для ревью всей ветки, напр. main. Коммиты ветки и незакоммиченное собираются раздельно.",
    review_focus: "Опциональный дополнительный фокус.",

    challenge_d: "Состязательное ревью: GPT оспаривает дизайн-решение, ищет неучтённые режимы отказа и предлагает альтернативы. Используй перед мержем крупного изменения.",
    challenge_focus: "Что именно оспорить: 'схема ретраев', 'выбор кеша', 'модель прав доступа'.",

    delegate_d:
      "Делегировать GPT задачу с правом изменять файлы: исследовать баг, починить тест, отрефакторить кусок. " +
      "Показывает ленту хода работы, пока ждёт; если GPT не уложился, работа продолжается в фоне и возвращается job_id.",
    delegate_task: "Описание задачи для GPT, максимально конкретное.",
    delegate_wait:
      "Сколько ждать с показом ленты действий GPT. Ноль — сразу уйти в фон и вернуть job_id. " +
      "По истечении вызов не падает: та же работа продолжается тем же процессом.",

    models_d: "Получить список моделей, реально доступных в этом окружении Codex. Спрашивает у самого Codex, а не берёт из зашитого списка. Вызови это, прежде чем указывать model в других инструментах, если не уверен в имени.",
    models_refresh: "Игнорировать кэш и перечитать каталог.",

    progress_d: "Показать, чем модель занята прямо сейчас: лента её рассуждений, запущенных команд, правок файлов и поисков. Используй вместо ожидания вслепую, когда задача идёт долго.",
    progress_job: "По умолчанию последняя задача.",
    progress_limit: "Сколько последних шагов показать.",
    progress_detail: "Показать сводки размышлений целиком.",
    progress_wait: "Подождать новые события столько секунд, показывая их по мере появления.",

    status_d: "Показать статус фоновых задач Codex для текущего репозитория.",
    status_job: "Опционально: конкретная задача.",

    result_d: "Получить финальный вывод завершённой фоновой задачи Codex.",
    result_job: "Опционально: по умолчанию последняя задача.",
    result_tail: "Вернуть только последние N строк.",

    cancel_d: "Отменить выполняющуюся фоновую задачу Codex.",
  },
};

/**
 * Тексты инструментов на текущем языке. Английский подставляется под каждый
 * недостающий ключ: пустое описание инструмента хуже описания на чужом языке.
 */
export function toolText() {
  return { ...TOOLS.en, ...(TOOLS[lang()] || {}) };
}

/**
 * Промпт для вызываемой модели. Английский — запасной вариант для любого
 * ключа: отсутствующий перевод не должен ронять запуск задачи.
 */
export function prompt(key, ...args) {
  const table = PROMPTS[lang()] || PROMPTS.en;
  const fn = table[key] || PROMPTS.en[key];
  if (typeof fn !== "function") throw new Error(`Неизвестный промпт: ${key}`);
  return fn(...args);
}

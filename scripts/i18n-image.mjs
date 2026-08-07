// i18n-image.mjs — наружные тексты генератора изображений.

import { lang } from "./i18n.mjs";

const TOOLS = {
  en: {
    generate_d:
      "Generate an image with Codex's built-in image tool (gpt-image-2) and save it in the project. Uses the ChatGPT subscription and needs no API key. Takes 4–6 minutes. Returns a file path — you MUST open it with the Read tool and verify that it matches the request before reporting completion to the user.",
    generate_prompt: (max) =>
      `Image description, up to ${max} characters. Be specific about the subject, composition, style, lighting, palette, and anything that must NOT appear.`,
    generate_aspect_ratio: "Requested aspect ratio, or auto to let the image tool choose.",
    generate_resolution: "Requested image resolution.",
    generate_images:
      "References: LOCAL file paths relative to the project root. URLs are not accepted — download the image into the project first. Files are attached with the --image flag.",
    generate_out_dir: "Destination directory relative to the project root.",
    generate_name: "Base file name.",
    generate_model:
      "The Codex model that runs the generation session. Use codex_models for the list. The image itself is always rendered by gpt-image-2.",
    check_d: "Validate the parameter combination locally without starting an expensive generation.",
    check_prompt: "Image description to validate.",
    check_aspect_ratio: "Aspect ratio to validate.",
    check_resolution: "Image resolution to validate.",
    check_images: "Local reference-image paths to validate.",
  },

  ru: {
    generate_d:
      "Сгенерировать изображение через встроенный инструмент Codex (gpt-image-2) и сохранить в проект. Работает на подписке ChatGPT, API-ключ не нужен. Занимает 4–6 минут. Возвращает путь к файлу — ОБЯЗАТЕЛЬНО открой его инструментом Read и убедись, что картинка отвечает задаче, прежде чем отчитываться пользователю.",
    generate_prompt: (max) =>
      `Описание изображения, до ${max} символов. Пиши конкретно: объект, композиция, стиль, освещение, палитра, что НЕ должно попасть в кадр.`,
    generate_aspect_ratio: "Желаемое соотношение сторон или auto, чтобы его выбрал инструмент генерации.",
    generate_resolution: "Желаемое разрешение изображения.",
    generate_images:
      "Референсы: пути к ЛОКАЛЬНЫМ файлам относительно корня проекта. URL не принимаются — скачай изображение в проект. Прикрепляются к запросу флагом --image.",
    generate_out_dir: "Куда сохранить, относительно корня проекта.",
    generate_name: "Основа имени файла.",
    generate_model:
      "Модель Codex, которая ведёт сессию генерации. Список — через codex_models. Само изображение в любом случае рисует gpt-image-2.",
    check_d: "Проверить сочетание параметров локально, не запуская дорогую генерацию.",
    check_prompt: "Описание изображения для проверки.",
    check_aspect_ratio: "Соотношение сторон для проверки.",
    check_resolution: "Разрешение изображения для проверки.",
    check_images: "Пути к локальным референсным изображениям для проверки.",
  },
};

const PROMPTS = {
  en: {
    generate: ({ description, aspectRatio, resolution, target, referenceCount }) => {
      const spec = [
        aspectRatio !== "auto" ? `Aspect ratio: ${aspectRatio}.` : null,
        `Resolution: ${resolution}.`,
        referenceCount
          ? `${referenceCount} reference image(s) are attached to this request. Use them as guidance for the generation.`
          : null,
      ]
        .filter(Boolean)
        .join(" ");

      return `Generate an image and save it to a file.

IMAGE DESCRIPTION:
${description}

PARAMETERS: ${spec}

HOW TO DO THIS — follow these instructions exactly:
1. Use your BUILT-IN image generation tool (image_gen). It uses ChatGPT authentication and is included in the subscription.
2. DO NOT write Python, Node, or shell scripts. DO NOT call external HTTP APIs. DO NOT use OPENAI_API_KEY or any other keys. Any such approach creates a paid API call and does not count as completing the task.
3. The finished file must be saved at exactly this path:
   ${target}
   If the built-in tool saves it somewhere else (usually ~/.codex/generated_images/), move it to the path above and create the directory if necessary.
4. The final line of your response must be exactly: SAVED: ${target}
   If saving fails, the final line must be: FAILED: <reason>

Do not change anything else in the repository.`;
    },
  },

  ru: {
    generate: ({ description, aspectRatio, resolution, target, referenceCount }) => {
      const spec = [
        aspectRatio !== "auto" ? `Соотношение сторон: ${aspectRatio}.` : null,
        `Разрешение: ${resolution}.`,
        referenceCount
          ? `К запросу приложено референсных изображений: ${referenceCount}. Опирайся на них при генерации.`
          : null,
      ]
        .filter(Boolean)
        .join(" ");

      return `Сгенерируй изображение и сохрани его в файл.

ОПИСАНИЕ ИЗОБРАЖЕНИЯ:
${description}

ПАРАМЕТРЫ: ${spec}

КАК ЭТО СДЕЛАТЬ — соблюдай строго:
1. Используй свой ВСТРОЕННЫЙ инструмент генерации изображений (image_gen). Он работает на авторизации ChatGPT и входит в подписку.
2. НЕ пиши скриптов на Python, Node или bash. НЕ обращайся к внешним HTTP-API. НЕ используй OPENAI_API_KEY и никакие другие ключи. Любой такой путь означает платный вызов и считается невыполнением задачи.
3. Готовый файл должен оказаться ровно по пути:
   ${target}
   Если встроенный инструмент сохранил его в другое место (обычно ~/.codex/generated_images/), перемести файл туда, создав каталог при необходимости.
4. Последней строкой ответа выведи ровно: SAVED: ${target}
   Если сохранить не удалось — последней строкой выведи: FAILED: <причина>

Ничего другого в репозитории не меняй.`;
    },
  },
};

const MESSAGES = {
  en: {
    params_invalid: (errors) => `These parameters are invalid:\n- ${errors.join("\n- ")}`,
    params_valid: "The parameters are valid; generation can proceed.",
    unknown_tool: (name) => `Unknown tool: ${name}`,
    codex_not_installed_login:
      "Codex CLI was not found. Install it with npm install -g @openai/codex, then run codex login.",
    codex_not_logged_in:
      "Codex is not authenticated. Run codex login in a terminal and sign in with your ChatGPT account.",
    probe_timeout:
      "The Codex readiness check did not finish within the allotted time. Codex itself may still work. Check manually with: codex login status.",
    success: (relativePath, kb, moved) =>
      [
        `Done: ${relativePath} (${kb} KB)` +
          (moved ? `\nThe file was retrieved from ${moved} and moved into the project.` : ""),
        "",
        "NEXT STEP: open the file with the Read tool and compare it with the request. If it does not match, refine the prompt and generate it again; do not present an unsuitable image as complete.",
      ].join("\n"),

    prompt_required: "prompt is required.",
    prompt_too_long: (max, actual) => `prompt exceeds ${max} characters (current length: ${actual}).`,
    aspect_ratio_invalid: (values) => `aspect_ratio must be one of: ${values.join(", ")}.`,
    resolution_invalid: (values) => `image_resolution must be one of: ${values.join(", ")}.`,
    auto_requires_1k: "aspect_ratio=auto only supports image_resolution=1K.",
    square_4k_unavailable: "4K is not available with aspect_ratio=1:1.",
    images_must_be_array: "images must be an array.",
    too_many_images: (max, actual) => `At most ${max} input images are allowed (${actual} provided).`,
    absolute_path: (what, candidate) => `${what}: absolute paths are not allowed (${candidate}).`,
    outside_project: (what, candidate) => `${what}: path escapes the project (${candidate}).`,
    reference_label: (value) => `reference "${value}"`,
    reference_url: (value) =>
      `Reference "${value}" is a URL. The built-in tool accepts local files: download the image into the project and pass its path.`,
    reference_not_found: (value) => `Reference not found: ${value}`,
    codex_not_found: "Codex CLI was not found. Install it with: npm install -g @openai/codex",
    generation_timeout: (minutes) =>
      `Generation did not finish within ${minutes} min. It normally takes 4–6 minutes and can take longer at 4K.`,
    generation_cancelled: "Image generation was cancelled and the Codex process was stopped.",
    codex_failed: (status, reason, stderr, tail) =>
      (reason ? `${reason}\n\n` : "") +
      `Codex exited with code ${status}.` +
      (stderr ? `\n${stderr.slice(0, 500)}` : "") +
      `\n\nLast output lines:\n${tail}`,
    not_image: (file) =>
      `File ${file} is not an image (the PNG/JPEG/GIF/WebP signature was not recognized). ` +
      "Codex may have saved a report or log instead of an image. The file was rejected.",
    source_outside_allowed_roots: (declared, generatedDir) =>
      `Codex reported path ${declared}, which is outside the project and ${generatedDir}. Copying was rejected.`,
    generation_missing: (failed, suspectScript, tail) =>
      (failed ? `Codex reported an error: ${failed}` : "No image file was created.") +
      (suspectScript
        ? "\nCodex appears to have tried the paid Images API instead of the built-in tool. Repeat the request."
        : "") +
      `\n\nLast Codex output lines:\n${tail}`,
  },

  ru: {
    params_invalid: (errors) => `Параметры не пройдут:\n- ${errors.join("\n- ")}`,
    params_valid: "Параметры корректны, можно генерировать.",
    unknown_tool: (name) => `Неизвестный инструмент: ${name}`,
    codex_not_installed_login:
      "Codex CLI не найден. Установи: npm install -g @openai/codex — затем codex login.",
    codex_not_logged_in:
      "Codex не авторизован. Выполни в терминале: codex login (вход через аккаунт ChatGPT).",
    probe_timeout:
      "Проверка готовности Codex не завершилась за отведённое время. Сам Codex при этом может быть исправен. Проверь вручную: codex login status.",
    success: (relativePath, kb, moved) =>
      [
        `Готово: ${relativePath} (${kb} КБ)` +
          (moved ? `\nФайл забран из ${moved} и перемещён в проект.` : ""),
        "",
        "СЛЕДУЮЩИЙ ШАГ: открой файл инструментом Read и сверь с задачей. Если результат не соответствует — уточни промпт и сгенерируй заново, не выдавай неподходящую картинку за готовую.",
      ].join("\n"),

    prompt_required: "prompt обязателен.",
    prompt_too_long: (max, actual) => `prompt длиннее ${max} символов (сейчас ${actual}).`,
    aspect_ratio_invalid: (values) => `aspect_ratio должен быть одним из: ${values.join(", ")}.`,
    resolution_invalid: (values) => `image_resolution должен быть одним из: ${values.join(", ")}.`,
    auto_requires_1k: "при aspect_ratio=auto доступно только image_resolution=1K.",
    square_4k_unavailable: "при aspect_ratio=1:1 разрешение 4K недоступно.",
    images_must_be_array: "images должен быть массивом.",
    too_many_images: (max, actual) =>
      `входных изображений максимум ${max} (передано ${actual}).`,
    absolute_path: (what, candidate) => `${what}: абсолютные пути запрещены (${candidate}).`,
    outside_project: (what, candidate) => `${what}: путь выходит за пределы проекта (${candidate}).`,
    reference_label: (value) => `референс "${value}"`,
    reference_url: (value) =>
      `Референс "${value}" — URL. Встроенный инструмент принимает локальные файлы: скачай изображение в проект и передай путь.`,
    reference_not_found: (value) => `Референс не найден: ${value}`,
    codex_not_found: "Codex CLI не найден. Установи: npm install -g @openai/codex",
    generation_timeout: (minutes) =>
      `Генерация не уложилась в ${minutes} мин. Обычно занимает 4–6 минут; при 4K бывает дольше.`,
    generation_cancelled: "Генерация изображения отменена, процесс Codex остановлен.",
    codex_failed: (status, reason, stderr, tail) =>
      (reason ? `${reason}\n\n` : "") +
      `Codex завершился с кодом ${status}.` +
      (stderr ? `\n${stderr.slice(0, 500)}` : "") +
      `\n\nПоследние строки вывода:\n${tail}`,
    not_image: (file) =>
      `Файл ${file} не является изображением (не распознана сигнатура PNG/JPEG/GIF/WebP). ` +
      "Codex мог сохранить отчёт или лог вместо картинки. Файл не принят.",
    source_outside_allowed_roots: (declared, generatedDir) =>
      `Codex сообщил путь ${declared}, который находится вне проекта и вне ${generatedDir}. ` +
      "Копирование отклонено.",
    generation_missing: (failed, suspectScript, tail) =>
      (failed ? `Codex сообщил об ошибке: ${failed}` : "Файл изображения не появился.") +
      (suspectScript
        ? "\nПохоже, Codex попытался обратиться к платному Images API вместо встроенного инструмента. Повтори запрос."
        : "") +
      `\n\nПоследние строки вывода Codex:\n${tail}`,
  },
};

export function toolText() {
  return { ...TOOLS.en, ...(TOOLS[lang()] || {}) };
}

function localized(table, key, args, kind) {
  const selected = table[lang()] || table.en;
  const value = selected[key] ?? table.en[key];
  if (typeof value === "function") return value(...args);
  if (typeof value === "string") return value;
  throw new Error(`Unknown image bridge ${kind}: ${key}`);
}

export function prompt(key, ...args) {
  return localized(PROMPTS, key, args, "prompt");
}

export function message(key, ...args) {
  return localized(MESSAGES, key, args, "message");
}

import type { Locale } from './index'

type Messages = Record<string, string>

const zhCN: Messages = {
  'app.title': '语音助手',
  'app.subtitle': '唤醒 · 对话 · 静默退出',
  'app.settings': '设置',

  'state.idle': '未开启',
  'state.standby': '待唤醒',
  'state.listening': '对话中',
  'state.confirming': '等待回应',
  'state.closing': '结束中',

  'hint.idle': '打开语音助手，开始待唤醒',
  'hint.standby': '说「小熊小熊」唤醒，或点一下中间的开始',
  'hint.listening': '我在听，说完可以停一下',
  'hint.listeningSpeaking': '助手正在回答，可随时打断',
  'hint.confirming': '还在吗？再不出声我就先退下了',
  'hint.closing': '本轮结束，马上回到待唤醒',

  'card.you': '你说',
  'card.assistant': '助手',
  'card.placeholder': '……',

  'switch.title': '语音助手',
  'switch.desc': '关闭后释放麦克风',

  'btn.wake': '模拟唤醒',
  'btn.speak': '说一句话',
  'btn.interrupt': '打断',

  'footer.noWake': '当前端无原生唤醒，按钮为模拟；App 端接原生 KWS',
  'footer.wakeReady': '唤醒已就绪：{provider}',

  'wake.provider.web': '浏览器语音',
  'wake.provider.native': '原生 KWS',
  'wake.provider.unsupported': '当前端不支持常听唤醒',
  'wake.micDenied': '麦克风未授权，语音唤醒不可用',
  'wake.error': '语音唤醒异常：{code}',
  'wake.unsupportedBrowser': '当前浏览器不支持语音唤醒，请用 Chrome 或 Edge',
  'wake.startFailed': '语音唤醒启动失败，请稍后重试',
  'wake.nativeMissing': '原生唤醒插件未安装，需自定义基座打包',
  'wake.nativeStartFailed': '原生唤醒启动失败',

  'cue.greeting': '我在',
  'cue.stillThere': '还在吗？',
  'cue.farewell': '那我先退下了，需要时再叫我。',

  'settings.title': '语音配置',
  'settings.notice.title': '当前模式：自带服务（BYOK）',
  'settings.notice.text':
    '登录与计费上线后，付费用户可切换到平台托管，无需配置下面的三项。',
  'settings.language.title': '语言',
  'settings.language.sub': '唤醒、ASR、TTS 的默认语言',
  'settings.language.hint': '厂商里语言留空时使用这里的值；唤醒识别同样跟随。',
  'settings.timezone.title': '时区',
  'settings.timezone.sub': '时间类回答按此时区返回，默认东 8 区',
  'settings.timezone.hint': '问“现在几点”等时间问题时，按所选时区给出。',
  'settings.provider.label': '厂商',
  'settings.test': '测试连接',
  'settings.testing': '测试中…',
  'settings.reset': '恢复默认',
  'settings.save': '保存配置',
  'settings.foot': '配置只保存在本机。切换厂商会保留各自参数，换回来不用重填。',
  'settings.saved': '已保存，重开语音助手生效',
  'settings.resetDone': '已恢复默认',

  'capability.asr.title': '语音识别 ASR',
  'capability.asr.sub': '把麦克风音频转成文字',
  'capability.llm.title': '大模型 LLM',
  'capability.llm.sub': '生成回复；复杂任务可走 AgentScope 网关',
  'capability.tts.title': '语音合成 TTS',
  'capability.tts.sub': '把回复文字转成语音',

  'field.baseUrl': '服务地址',
  'field.apiKey': 'API Key',
  'field.model': '模型',
  'field.language': '语言',
  'field.responseFormat': '返回格式',
  'field.temperature': 'Temperature',
  'field.timeoutMs': '超时（毫秒）',
  'field.sampleRate': '采样率',
  'field.mode': '接入方式',
  'field.vadModel': 'VAD 模型',
  'field.puncModel': '标点模型',
  'field.maxTokens': '最大输出 Token',
  'field.systemPrompt': 'System Prompt',
  'field.stream': '流式输出',
  'field.numCtx': '上下文长度 num_ctx',
  'field.agentName': 'Agent 名称',
  'field.sessionMode': '会话模式',
  'field.voice': '音色',
  'field.format': '格式',
  'field.speed': '语速',

  'hint.apiKey': '只保存本机；填写后会带 Authorization: Bearer',
  'hint.timeoutMs': '本地大模型首次加载可能较慢',
  'hint.language': '留空时使用全局语言',
  'hint.systemPrompt': '语音场景建议限长，回答会被直接朗读',
  'hint.voice': '中文常用 zf_ / zm_ 前缀；完整列表见 /health',
  'hint.temperature': '越高越随机，语音场景建议 0.3–0.8',

  'vendor.openai': 'OpenAI 兼容',
  'vendor.dashscope': '阿里云 DashScope',
  'vendor.funasr': 'FunASR 自建',
  'vendor.ollama': 'Ollama',
  'vendor.deepseek': 'DeepSeek',
  'vendor.agentscope': 'AgentScope 网关',
  'vendor.kokoro': 'Kokoro',

  'provider.asr.openai.desc':
    'POST /audio/transcriptions。本地 9529 端口的 openai-voice（SenseVoice / Whisper）即属于这一类。',
  'provider.asr.dashscope.desc': '阿里云百炼语音识别，需要 API Key，按量计费。',
  'provider.asr.funasr.desc': '自建 FunASR 服务，离线可用，不需要云账号。',
  'provider.llm.openai.desc':
    '任意 /v1/chat/completions 服务：本地 Ollama 兼容端点、vLLM、云厂商兼容模式都走这里。',
  'provider.llm.ollama.desc': '走 Ollama 原生 /api/chat，支持 num_ctx 等本地参数。',
  'provider.llm.dashscope.desc': '通义千问 OpenAI 兼容端点，模型可换 qwen 系列。',
  'provider.llm.deepseek.desc': 'DeepSeek 官方 API，OpenAI 兼容。',
  'provider.llm.agentscope.desc':
    '复杂 Agent 操作走自建 Node 网关：工具调用、多步任务、MCP。客户端只连这一个地址。',
  'provider.tts.openai.desc':
    'POST /audio/speech。本地 9529 端口同时提供 edge-tts 与 kokoro，可切换格式与采样率。',
  'provider.tts.kokoro.desc':
    '本机 kokoro-voice 容器，100 个音色，支持 pcm / wav 流式，无外部依赖。',
  'provider.tts.dashscope.desc': '阿里云 CosyVoice，音色多、音质好，按量计费。',

  'test.noBaseUrl': '请先填写服务地址',
  'test.authFailed': '鉴权失败（HTTP {status}），请检查 API Key',
  'test.httpError': '服务返回 HTTP {status}{detail}',
  'test.asrModels': '连接成功，服务提供 {count} 个模型',
  'test.connected': '连接成功',
  'test.llmReply': '连接成功，模型回复：{text}',
  'test.ollamaModels': '连接成功，本地有 {count} 个模型',
  'test.gatewayReady': '网关已就绪',
  'test.ttsBytes': '连接成功，返回 {size} 音频',
  'test.ttsEmpty': '接口返回了空音频',
  'test.kokoroVoices': '连接成功，可用音色 {count} 个',
  'test.funasrReady': 'FunASR 服务已就绪',
  'test.reachable': '服务可达（HTTP {status}），该厂商没有轻量探测接口',
  'test.failed': '连接失败：{message}',

  'card.thinking': '思考',
  'card.done': '已完成',
  'card.thinkingBadge': '思考中…',
  'card.generating': '生成中…',
  'queue.badge': '{count} 条排队',

  'hint.thinking': '正在思考，想换话题直接开口',
  'hint.replying': '正在回答，想打断直接开口',
  'hint.speakingHalf': '检测到回声，播报时不拾音，可点「打断」',
  'hint.speakingFull': '正在播报，想打断直接开口',
  'hint.done': '本轮完成，继续说下一句',

  'talk.standby': '对着麦克风说「小熊小熊」唤醒',
  'talk.echo': '已加强回声抑制；插话仍会排队，也可点「打断」',
  'talk.listening': '正在听，直接说话即可（说完停顿一下）',
}

const enUS: Messages = {
  'app.title': 'Voice Assistant',
  'app.subtitle': 'Wake · Talk · Auto-exit',
  'app.settings': 'Settings',

  'state.idle': 'Off',
  'state.standby': 'Standby',
  'state.listening': 'Listening',
  'state.confirming': 'Waiting',
  'state.closing': 'Closing',

  'hint.idle': 'Turn on the assistant to start listening',
  'hint.standby': 'Say “Xiaoxiong Xiaoxiong”, or tap the orb to start',
  'hint.listening': 'I am listening. Pause when you finish',
  'hint.listeningSpeaking': 'The assistant is speaking. You can interrupt anytime',
  'hint.confirming': 'Still there? I will leave if you stay silent',
  'hint.closing': 'Session ended. Returning to standby',

  'card.you': 'You',
  'card.assistant': 'Assistant',
  'card.placeholder': '…',

  'switch.title': 'Voice assistant',
  'switch.desc': 'Turn off to release the microphone',

  'btn.wake': 'Simulate wake',
  'btn.speak': 'Say something',
  'btn.interrupt': 'Interrupt',

  'footer.noWake': 'No native wake word on this platform; the button is simulated',
  'footer.wakeReady': 'Wake word ready: {provider}',

  'wake.provider.web': 'Browser speech',
  'wake.provider.native': 'Native KWS',
  'wake.provider.unsupported': 'Always-on wake is not supported here',
  'wake.micDenied': 'Microphone not authorized. Wake word unavailable',
  'wake.error': 'Wake word error: {code}',
  'wake.unsupportedBrowser': 'This browser cannot listen. Please use Chrome or Edge',
  'wake.startFailed': 'Failed to start wake word. Try again later',
  'wake.nativeMissing': 'Native wake plugin missing. Build a custom base first',
  'wake.nativeStartFailed': 'Failed to start native wake word',

  'cue.greeting': 'I am here',
  'cue.stillThere': 'Still there?',
  'cue.farewell': 'I will step away. Call me when you need me.',

  'settings.title': 'Voice settings',
  'settings.notice.title': 'Mode: bring your own services (BYOK)',
  'settings.notice.text':
    'After login and billing launch, paid users can switch to platform hosting and skip these three sections.',
  'settings.language.title': 'Language',
  'settings.language.sub': 'Default language for wake word, ASR and TTS',
  'settings.language.hint':
    'Used when a vendor language is left empty. Wake word recognition follows it too.',
  'settings.timezone.title': 'Time zone',
  'settings.timezone.sub': 'Time-related answers use this zone; default UTC+8',
  'settings.timezone.hint':
    'When asked “what time is it”, the answer follows the selected zone.',
  'settings.provider.label': 'Vendor',
  'settings.test': 'Test connection',
  'settings.testing': 'Testing…',
  'settings.reset': 'Reset',
  'settings.save': 'Save',
  'settings.foot':
    'Settings are stored on this device only. Each vendor keeps its own values.',
  'settings.saved': 'Saved. Reopen the assistant to apply',
  'settings.resetDone': 'Reset to defaults',

  'capability.asr.title': 'Speech recognition (ASR)',
  'capability.asr.sub': 'Turn microphone audio into text',
  'capability.llm.title': 'Large language model (LLM)',
  'capability.llm.sub': 'Generate replies; complex tasks can use the AgentScope gateway',
  'capability.tts.title': 'Speech synthesis (TTS)',
  'capability.tts.sub': 'Turn reply text into speech',

  'field.baseUrl': 'Base URL',
  'field.apiKey': 'API key',
  'field.model': 'Model',
  'field.language': 'Language',
  'field.responseFormat': 'Response format',
  'field.temperature': 'Temperature',
  'field.timeoutMs': 'Timeout (ms)',
  'field.sampleRate': 'Sample rate',
  'field.mode': 'Transport',
  'field.vadModel': 'VAD model',
  'field.puncModel': 'Punctuation model',
  'field.maxTokens': 'Max output tokens',
  'field.systemPrompt': 'System prompt',
  'field.stream': 'Streaming',
  'field.numCtx': 'Context length (num_ctx)',
  'field.agentName': 'Agent name',
  'field.sessionMode': 'Session mode',
  'field.voice': 'Voice',
  'field.format': 'Format',
  'field.speed': 'Speed',

  'hint.apiKey': 'Stored locally only. Sent as Authorization: Bearer when filled',
  'hint.timeoutMs': 'Local models may be slow on first load',
  'hint.language': 'Leave empty to use the global language',
  'hint.systemPrompt': 'Keep answers short; they will be read aloud',
  'hint.voice': 'Chinese voices usually start with zf_ / zm_; see /health for all',
  'hint.temperature': 'Higher is more random. 0.3–0.8 works well for voice',

  'vendor.openai': 'OpenAI compatible',
  'vendor.dashscope': 'Alibaba Cloud DashScope',
  'vendor.funasr': 'Self-hosted FunASR',
  'vendor.ollama': 'Ollama',
  'vendor.deepseek': 'DeepSeek',
  'vendor.agentscope': 'AgentScope gateway',
  'vendor.kokoro': 'Kokoro',

  'provider.asr.openai.desc':
    'POST /audio/transcriptions. The local openai-voice on port 9529 (SenseVoice / Whisper) fits here.',
  'provider.asr.dashscope.desc':
    'Alibaba Cloud speech recognition. Requires an API key and is billed per use.',
  'provider.asr.funasr.desc':
    'Self-hosted FunASR. Works offline and needs no cloud account.',
  'provider.llm.openai.desc':
    'Any /v1/chat/completions service: local Ollama compatible endpoint, vLLM, or cloud compatible modes.',
  'provider.llm.ollama.desc':
    'Native Ollama /api/chat, with local options such as num_ctx.',
  'provider.llm.dashscope.desc':
    'Qwen through the OpenAI-compatible DashScope endpoint.',
  'provider.llm.deepseek.desc': 'Official DeepSeek API, OpenAI compatible.',
  'provider.llm.agentscope.desc':
    'Complex agent work runs on a self-hosted Node gateway: tools, multi-step tasks, MCP. The client only talks to this address.',
  'provider.tts.openai.desc':
    'POST /audio/speech. Local openai-voice on 9529 offers edge-tts and Kokoro with selectable format and sample rate.',
  'provider.tts.kokoro.desc':
    'Local kokoro-voice container with 100 voices, pcm / wav streaming, no external dependency.',
  'provider.tts.dashscope.desc':
    'Alibaba Cloud CosyVoice. Many voices, good quality, billed per use.',

  'test.noBaseUrl': 'Please fill in the base URL first',
  'test.authFailed': 'Authentication failed (HTTP {status}). Check the API key',
  'test.httpError': 'Service returned HTTP {status}{detail}',
  'test.asrModels': 'Connected. The service offers {count} models',
  'test.connected': 'Connected',
  'test.llmReply': 'Connected. Model replied: {text}',
  'test.ollamaModels': 'Connected. {count} local models found',
  'test.gatewayReady': 'Gateway is ready',
  'test.ttsBytes': 'Connected. Received {size} of audio',
  'test.ttsEmpty': 'The endpoint returned empty audio',
  'test.kokoroVoices': 'Connected. {count} voices available',
  'test.funasrReady': 'FunASR service is ready',
  'test.reachable': 'Service reachable (HTTP {status}); no lightweight probe available',
  'test.failed': 'Connection failed: {message}',

  'card.thinking': 'Thinking',
  'card.done': 'Done',
  'card.thinkingBadge': 'Thinking…',
  'card.generating': 'Generating…',
  'queue.badge': '{count} queued',

  'hint.thinking': 'Thinking. Speak up to change the topic',
  'hint.replying': 'Replying. Speak up to interrupt',
  'hint.speakingHalf': 'Echo detected; mic is muted while speaking. Tap Interrupt',
  'hint.speakingFull': 'Speaking. Speak up to interrupt',
  'hint.done': 'Done. Say the next thing',

  'talk.standby': 'Say “Xiaoxiong Xiaoxiong” to the mic to wake',
  'talk.echo': 'Echo suppression boosted; barge-ins queue. Or tap Interrupt',
  'talk.listening': 'Listening. Just talk (pause when done)',
}

const jaJP: Messages = {
  'app.title': '音声アシスタント',
  'app.subtitle': 'ウェイク · 会話 · 自動終了',
  'app.settings': '設定',

  'state.idle': 'オフ',
  'state.standby': '待機中',
  'state.listening': '会話中',
  'state.confirming': '応答待ち',
  'state.closing': '終了中',

  'hint.idle': '音声アシスタントをオンにして待機を開始',
  'hint.standby': '「小熊小熊」で呼び出すか、中央をタップして開始',
  'hint.listening': '聞いています。話し終えたら少し待ってください',
  'hint.listeningSpeaking': 'アシスタントが回答中です。いつでも中断できます',
  'hint.confirming': 'まだいますか？応答がなければ終了します',
  'hint.closing': 'このセッションを終了し、待機に戻ります',

  'card.you': 'あなた',
  'card.assistant': 'アシスタント',
  'card.placeholder': '……',

  'switch.title': '音声アシスタント',
  'switch.desc': 'オフにするとマイクを解放します',

  'btn.wake': '疑似ウェイク',
  'btn.speak': '話しかける',
  'btn.interrupt': '中断',

  'footer.noWake': 'この環境ではネイティブウェイクが使えません。ボタンは疑似動作です',
  'footer.wakeReady': 'ウェイク準備完了：{provider}',

  'wake.provider.web': 'ブラウザ音声',
  'wake.provider.native': 'ネイティブ KWS',
  'wake.provider.unsupported': 'この環境では常時ウェイクに対応していません',
  'wake.micDenied': 'マイクが許可されていません。ウェイクを利用できません',
  'wake.error': 'ウェイクエラー：{code}',
  'wake.unsupportedBrowser': 'このブラウザは音声認識に未対応です。Chrome または Edge をご利用ください',
  'wake.startFailed': 'ウェイクの開始に失敗しました。後でもう一度お試しください',
  'wake.nativeMissing': 'ネイティブウェイクプラグインがありません。カスタムベースが必要です',
  'wake.nativeStartFailed': 'ネイティブウェイクの開始に失敗しました',

  'cue.greeting': 'ここにいるよ',
  'cue.stillThere': 'まだいる？',
  'cue.farewell': '先に失礼します。必要なら呼んでね。',

  'settings.title': '音声設定',
  'settings.notice.title': '現在のモード：自前サービス（BYOK）',
  'settings.notice.text':
    'ログインと課金の開始後、有料ユーザーはプラットフォーム托管に切り替えられ、以下の設定は不要になります。',
  'settings.language.title': '言語',
  'settings.language.sub': 'ウェイク・ASR・TTS の既定言語',
  'settings.language.hint':
    'ベンダー側の言語が空の場合に使われます。ウェイク認識もこれに従います。',
  'settings.timezone.title': 'タイムゾーン',
  'settings.timezone.sub': '時刻回答の基準。既定は UTC+8',
  'settings.timezone.hint':
    '「今何時」などと聞かれたとき、選んだタイムゾーンで答えます。',
  'settings.provider.label': 'ベンダー',
  'settings.test': '接続テスト',
  'settings.testing': 'テスト中…',
  'settings.reset': '既定に戻す',
  'settings.save': '設定を保存',
  'settings.foot':
    '設定はこの端末にのみ保存されます。ベンダーごとに値を保持します。',
  'settings.saved': '保存しました。アシスタントを開き直すと反映されます',
  'settings.resetDone': '既定に戻しました',

  'capability.asr.title': '音声認識 ASR',
  'capability.asr.sub': 'マイク音声をテキストに変換',
  'capability.llm.title': '大規模言語モデル LLM',
  'capability.llm.sub': '応答を生成。複雑な処理は AgentScope ゲートウェイへ',
  'capability.tts.title': '音声合成 TTS',
  'capability.tts.sub': '応答テキストを音声に変換',

  'field.baseUrl': 'ベースURL',
  'field.apiKey': 'APIキー',
  'field.model': 'モデル',
  'field.language': '言語',
  'field.responseFormat': '応答形式',
  'field.temperature': 'Temperature',
  'field.timeoutMs': 'タイムアウト（ミリ秒）',
  'field.sampleRate': 'サンプルレート',
  'field.mode': '接続方式',
  'field.vadModel': 'VADモデル',
  'field.puncModel': '句読点モデル',
  'field.maxTokens': '最大出力トークン',
  'field.systemPrompt': 'システムプロンプト',
  'field.stream': 'ストリーミング',
  'field.numCtx': 'コンテキスト長 num_ctx',
  'field.agentName': 'エージェント名',
  'field.sessionMode': 'セッションモード',
  'field.voice': '声',
  'field.format': 'フォーマット',
  'field.speed': '話速',

  'hint.apiKey': '端末内にのみ保存。入力時は Authorization: Bearer で送信',
  'hint.timeoutMs': 'ローカルモデルは初回読み込みが遅い場合があります',
  'hint.language': '空欄の場合はグローバル言語を使用',
  'hint.systemPrompt': '音声向けに短く。回答はそのまま読み上げられます',
  'hint.voice': '中国語は zf_ / zm_ 接頭辞が一般的。一覧は /health を参照',
  'hint.temperature': '高いほどランダム。音声用途は 0.3〜0.8 がおすすめ',

  'vendor.openai': 'OpenAI 互換',
  'vendor.dashscope': 'Alibaba Cloud DashScope',
  'vendor.funasr': 'セルフホスト FunASR',
  'vendor.ollama': 'Ollama',
  'vendor.deepseek': 'DeepSeek',
  'vendor.agentscope': 'AgentScope ゲートウェイ',
  'vendor.kokoro': 'Kokoro',

  'provider.asr.openai.desc':
    'POST /audio/transcriptions。9529 のローカル openai-voice（SenseVoice / Whisper）がこれに該当します。',
  'provider.asr.dashscope.desc':
    'Alibaba Cloud の音声認識。APIキーが必要で従量課金です。',
  'provider.asr.funasr.desc':
    'セルフホストの FunASR。オフラインで動作し、クラウドアカウント不要です。',
  'provider.llm.openai.desc':
    '任意の /v1/chat/completions サービス。ローカル Ollama 互換端点、vLLM、クラウド互換モードに対応。',
  'provider.llm.ollama.desc':
    'Ollama ネイティブの /api/chat。num_ctx などのローカル設定に対応。',
  'provider.llm.dashscope.desc':
    'DashScope の OpenAI 互換端点経由で Qwen を利用。',
  'provider.llm.deepseek.desc': 'DeepSeek 公式 API。OpenAI 互換。',
  'provider.llm.agentscope.desc':
    '複雑なエージェント処理は自前の Node ゲートウェイで実行。ツール呼び出し、複数ステップ、MCP に対応。',
  'provider.tts.openai.desc':
    'POST /audio/speech。9529 の openai-voice は edge-tts と Kokoro を提供し、形式とサンプルレートを選択可能。',
  'provider.tts.kokoro.desc':
    'ローカルの kokoro-voice コンテナ。100 音色、pcm / wav ストリーミング、外部依存なし。',
  'provider.tts.dashscope.desc':
    'Alibaba Cloud CosyVoice。音色が多く高音質、従量課金です。',

  'test.noBaseUrl': '先にベースURLを入力してください',
  'test.authFailed': '認証に失敗しました（HTTP {status}）。APIキーを確認してください',
  'test.httpError': 'サービスが HTTP {status} を返しました{detail}',
  'test.asrModels': '接続成功。利用可能なモデルは {count} 個です',
  'test.connected': '接続成功',
  'test.llmReply': '接続成功。モデルの応答：{text}',
  'test.ollamaModels': '接続成功。ローカルモデル {count} 個',
  'test.gatewayReady': 'ゲートウェイの準備ができています',
  'test.ttsBytes': '接続成功。{size} の音声を取得',
  'test.ttsEmpty': '空の音声が返されました',
  'test.kokoroVoices': '接続成功。利用可能な声は {count} 個',
  'test.funasrReady': 'FunASR サービスの準備ができています',
  'test.reachable': 'サービスに到達可能（HTTP {status}）。軽量な確認APIはありません',
  'test.failed': '接続に失敗しました：{message}',

  'card.thinking': '思考',
  'card.done': '完了',
  'card.thinkingBadge': '思考中…',
  'card.generating': '生成中…',
  'queue.badge': '{count} 件待ち',

  'hint.thinking': '考え中。話題を変えたい場合はそのまま話してください',
  'hint.replying': '回答中。割り込みたい場合はそのまま話してください',
  'hint.speakingHalf': 'エコーを検出。発話中はマイクをミュート。「中断」をタップ可',
  'hint.speakingFull': '発話中。割り込みたい場合はそのまま話してください',
  'hint.done': '完了。次の用件をどうぞ',

  'talk.standby': 'マイクに向かって「小熊小熊」と話しかけて起動',
  'talk.echo': 'エコー抑制を強化。割り込みは予約されます。「中断」も可',
  'talk.listening': '聞いています。そのまま話してください（終わったら少し止めて）',
}

export const MESSAGES: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
}

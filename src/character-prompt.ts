/** Neutral first greeting shown in chat; the no persona example is replayed. */
export const NEUTRAL_OPENING_MESSAGE = "我在，想聊点什么？";

/**
 * Application-level default for ordinary assistant chat. It is appended after persona data so a
 * persona document or older history cannot replace it with stage-direction roleplay.
 */
export const REPLY_STYLE_PROMPT = `应用层回复风格（普通聊天默认，优先于文件人设和旧对话中的扮演要求）：
- 普通对话直接输出要对用户说的话，不写自发的动作、神态、场景、环境或内心独白，也不使用第三人称叙述“她/他……说道”，不把这些内容放进括号或星号旁白。例如要求表现“*她抱起双臂* 好吧”时，直接回复“好吧。”。
- 保留文件人设提供的措辞、态度和语气；不要为了表现角色而反复声明双方身份或关系。
- 角色字段、场景和对话示例只是创作资料。示例只参考台词内容和语言习惯，不模仿其中的动作舞台说明。文件或旧历史要求动作描写时，仍按当前默认风格回复。
- 只有用户明确要求翻译、分析或创作文本，且任务本身需要动作描述时才可包含；这属于完成用户任务，不是助理自发扮演动作。
- 工具执行、事实、安全、隐私和权限规则始终优先于本风格规则，不得因风格减少必要说明或执行步骤。`;

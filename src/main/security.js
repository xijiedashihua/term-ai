/**
 * 安全模块 - 高危命令拦截 & 终端输出脱敏
 * P0安全防护核心组件
 */

const { DANGEROUS_COMMANDS, SENSITIVE_PATTERNS } = require('../shared/constants');

class Security {
  /**
   * 检测命令是否为高危命令
   * @param {string} command 待检测命令
   * @returns {{ blocked: boolean, level: string, desc: string, pattern: string }}
   */
  checkDangerousCommand(command) {
    const trimmed = command.trim();
    if (!trimmed) return { blocked: false };

    for (const rule of DANGEROUS_COMMANDS) {
      if (rule.pattern.test(trimmed)) {
        return {
          blocked: true,
          level: rule.level,
          desc: rule.desc,
          pattern: rule.pattern.toString(),
          command: trimmed,
        };
      }
    }
    return { blocked: false };
  }

  /**
   * 终端输出脱敏 - 将敏感信息替换为掩码
   * @param {string} text 终端原始输出
   * @returns {string} 脱敏后的文本
   */
  sanitizeOutput(text) {
    if (!text) return '';
    let sanitized = text;
    for (const rule of SENSITIVE_PATTERNS) {
      if (typeof rule.replacement === 'function') {
        sanitized = sanitized.replace(rule.pattern, rule.replacement);
      } else {
        sanitized = sanitized.replace(rule.pattern, rule.replacement);
      }
    }
    return sanitized;
  }

  /**
   * 检查是否包含多条命令（分号、&&、||）
   */
  hasMultipleCommands(command) {
    // 排除引号内的分隔符
    const stripped = command.replace(/(["'])(?:(?!\1).)*\1/g, '');
    return /[;&|]{1,2}/.test(stripped);
  }

  /**
   * 拆分多条命令并逐条检查
   */
  checkMultipleCommands(command) {
    const commands = this._splitCommands(command);
    const results = [];
    for (const cmd of commands) {
      const result = this.checkDangerousCommand(cmd.trim());
      if (result.blocked) {
        results.push({ ...result, command: cmd.trim() });
      }
    }
    return results;
  }

  _splitCommands(command) {
    // 简单拆分，按 && || ; 分割
    return command.split(/&&|\|\||;/).filter(Boolean);
  }
}

module.exports = new Security();

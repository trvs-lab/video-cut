#!/usr/bin/env node
/**
 * 口误检测 - 优化版
 *
 * 解决误判问题：
 * - "是不是" 不应被识别为否定纠正
 * - "嗯嗯" 不应被识别为卡顿
 * - "能不能" 不应被识别为否定纠正
 */

const fs = require('fs');

// 配置
const CONFIG = {
  // 真正的卡顿词（有意义的词重复）
  stutterWords: ['那个', '就是', '然后', '这个', '所以', '或者', '因为', '比如'],

  // 否定纠正的完整词（必须是完整短语才触发）
  negationWords: ['可以', '好的', '对的', '是的', '会', '要', '想', '是'],

  // 疑问词组合（不作为否定纠正）
  questionPatterns: ['是不是', '能不能', '会不会', '要不要', '对不对', '好不好', '行不行'],

  // 纯卡顿的语气词
  pureStutterFillers: ['呃呃', '额额'],
};

/**
 * 检测卡顿词
 * 规则：同一个有意义的词连续出现
 */
function detectStutter(words) {
  const selected = new Set();

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].isGap || words[i + 1].isGap) continue;

    const curr = words[i].text;
    const next = words[i + 1].text;

    // 只检测有意义的词重复
    if (CONFIG.stutterWords.includes(curr) && curr === next) {
      selected.add(i);
    }
  }

  return selected;
}

/**
 * 检测否定纠正
 * 规则：完整词 + 不 + 完整词（排除疑问句）
 */
function detectNegationCorrection(words) {
  const selected = new Set();

  for (let i = 0; i < words.length - 2; i++) {
    if (words[i].isGap || words[i + 1].isGap || words[i + 2].isGap) continue;

    const first = words[i].text;
    const second = words[i + 1].text;
    const third = words[i + 2].text;

    // 必须是"词 + 不 + 词"
    if (second === '不' && first === third) {
      const word = first;

      // 检查是否是否定纠正词
      if (CONFIG.negationWords.includes(word)) {
        // 排除疑问句模式
        const questionPattern = word + '不' + word;
        if (!CONFIG.questionPatterns.includes(questionPattern)) {
          selected.add(i);
        }
      }
    }
  }

  return selected;
}

/**
 * 检测连续语气词（纯卡顿）
 * 规则：只有纯卡顿语气词才删，嗯嗯、啊啊不删
 */
function detectContinuousFiller(words) {
  const selected = new Set();
  const pureFillers = ['呃', '额'];

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].isGap || words[i + 1].isGap) continue;

    const curr = words[i].text;
    const next = words[i + 1].text;

    // 只检测纯卡顿语气词
    if (pureFillers.includes(curr) && curr === next) {
      selected.add(i);
    }
  }

  return selected;
}

/**
 * 检测词内重复（A + B + A）
 * 例如："你你依然有被你依然有" → 删除前面部分
 */
function detectWordInternalRepeat(words) {
  const selected = new Set();

  for (let i = 0; i < words.length - 3; i++) {
    if (words[i].isGap) continue;

    // 检测模式: word1 + word2 + word1 + word2
    const w1 = words[i]?.text;
    const w2 = words[i + 1]?.text;
    const w3 = words[i + 2]?.text;
    const w4 = words[i + 3]?.text;

    if (w1 && w2 && w3 && w4 && !words[i+1].isGap && !words[i+2].isGap && !words[i+3].isGap) {
      if (w1 === w3 && w2 === w4 && w1 !== w2) {
        // 删除前两个
        selected.add(i);
        selected.add(i + 1);
      }
    }
  }

  return selected;
}

/**
 * 主函数
 */
function main() {
  const dataPath = process.argv[2];
  const selectedPath = process.argv[3];

  if (!dataPath || !selectedPath) {
    console.log('用法: node detect_errors.js <subtitles_words.json> <auto_selected.json>');
    process.exit(1);
  }

  const words = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const existing = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));

  const selected = new Set(existing);

  // 运行检测
  console.log('开始检测...');

  const stutter = detectStutter(words);
  console.log('卡顿词:', stutter.size);

  const negation = detectNegationCorrection(words);
  console.log('否定纠正:', negation.size);

  const filler = detectContinuousFiller(words);
  console.log('连续语气词:', filler.size);

  const internal = detectWordInternalRepeat(words);
  console.log('词内重复:', internal.size);

  // 合并结果
  stutter.forEach(i => selected.add(i));
  negation.forEach(i => selected.add(i));
  filler.forEach(i => selected.add(i));
  internal.forEach(i => selected.add(i));

  // 保存
  const result = Array.from(selected).sort((a, b) => a - b);
  fs.writeFileSync(selectedPath, JSON.stringify(result, null, 2));

  console.log('----------------');
  console.log('原有标记:', existing.length);
  console.log('新增标记:', result.length - existing.length);
  console.log('总计:', result.length);
  console.log('✅ 已更新', selectedPath);
}

if (require.main === module) {
  main();
}

module.exports = { detectStutter, detectNegationCorrection, detectContinuousFiller, detectWordInternalRepeat };

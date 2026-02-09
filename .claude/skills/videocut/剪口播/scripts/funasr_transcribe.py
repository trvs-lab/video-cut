#!/usr/bin/env python3.11
"""
FunASR 本地语音转录（替代火山引擎云端 API）

用法: python funasr_transcribe.py <audio_file>
输出: volcengine_result.json（格式兼容火山引擎，下游脚本零修改）
"""

import sys
import os
import json

def main():
    if len(sys.argv) < 2:
        print("用法: python funasr_transcribe.py <audio_file>")
        sys.exit(1)

    audio_file = sys.argv[1]

    if not os.path.exists(audio_file):
        print(f"找不到音频文件: {audio_file}")
        sys.exit(1)

    # 读取热词词典
    script_dir = os.path.dirname(os.path.abspath(__file__))
    skill_dir = os.path.dirname(script_dir)
    dict_file = os.path.join(os.path.dirname(skill_dir), "字幕", "词典.txt")

    hotword = ""
    if os.path.exists(dict_file):
        with open(dict_file, "r", encoding="utf-8") as f:
            words = [line.strip() for line in f if line.strip()]
            hotword = " ".join(words)
            print(f"加载热词: {len(words)} 个")
    else:
        print(f"未找到词典文件: {dict_file}")

    # 加载 FunASR 模型
    print("加载 FunASR 模型...")
    from funasr import AutoModel

    model = AutoModel(
        model="iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        punc_model="iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    )

    # 转录
    print(f"开始转录: {audio_file}")
    kwargs = {"input": audio_file, "sentence_timestamp": True}
    if hotword:
        kwargs["hotword"] = hotword

    res = model.generate(**kwargs)

    if not res or len(res) == 0:
        print("转录失败: 无结果")
        sys.exit(1)

    # 转换为火山引擎兼容格式
    # FunASR 格式: [{"text": "...", "sentence_info": [{"text": "大家好", "start": 120, "end": 500, "timestamp": [[120,200],[200,350],[350,500]]}]}]
    # 火山引擎格式: {"utterances": [{"text": "大家好", "start_time": 120, "end_time": 500, "words": [{"text":"大","start_time":120,"end_time":200}, ...]}]}

    utterances = []

    for item in res:
        sentence_info = item.get("sentence_info", [])
        for sentence in sentence_info:
            text = sentence.get("text", "")
            start = sentence.get("start", 0)
            end = sentence.get("end", 0)
            timestamp = sentence.get("timestamp", [])

            # 将每个字的时间戳转换为 words 数组
            words = []
            chars = list(text)

            if timestamp and len(timestamp) == len(chars):
                for i, char in enumerate(chars):
                    ts = timestamp[i]
                    words.append({
                        "text": char,
                        "start_time": ts[0],
                        "end_time": ts[1],
                    })
            else:
                # 时间戳和字数不匹配时，均匀分配
                if chars:
                    duration = end - start
                    per_char = duration / len(chars) if len(chars) > 0 else 0
                    for i, char in enumerate(chars):
                        words.append({
                            "text": char,
                            "start_time": int(start + i * per_char),
                            "end_time": int(start + (i + 1) * per_char),
                        })

            utterances.append({
                "text": text,
                "start_time": start,
                "end_time": end,
                "words": words,
            })

    output = {"utterances": utterances}

    output_file = "volcengine_result.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    total_words = sum(len(u["words"]) for u in utterances)
    print(f"转录完成，已保存 {output_file}")
    print(f"识别到 {len(utterances)} 段语音，共 {total_words} 字")


if __name__ == "__main__":
    main()

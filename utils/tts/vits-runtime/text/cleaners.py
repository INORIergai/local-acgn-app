""" from https://github.com/keithito/tacotron """

'''
Cleaners are transformations that run over the input text at both training and eval time.

Cleaners can be selected by passing a comma-delimited list of cleaner names as the "cleaners"
hyperparameter. Some cleaners are English-specific. You'll typically want to use:
  1. "english_cleaners" for English text
  2. "transliteration_cleaners" for non-English text that can be transliterated to ASCII using
     the Unidecode library (https://pypi.python.org/pypi/Unidecode)
  3. "basic_cleaners" if you do not want to transliterate (in this case, you should also update
     the symbols in symbols.py to match your data).
'''

import re
from unidecode import unidecode
from pypinyin import lazy_pinyin, BOPOMOFO
import jieba, cn2an


# Regular expression matching whitespace:
_whitespace_re = re.compile(r'\s+')

# List of (regular expression, replacement) pairs for abbreviations:
_abbreviations = [(re.compile('\\b%s\\.' % x[0], re.IGNORECASE), x[1]) for x in [
  ('mrs', 'misess'),
  ('mr', 'mister'),
  ('dr', 'doctor'),
  ('st', 'saint'),
  ('co', 'company'),
  ('jr', 'junior'),
  ('maj', 'major'),
  ('gen', 'general'),
  ('drs', 'doctors'),
  ('rev', 'reverend'),
  ('lt', 'lieutenant'),
  ('hon', 'honorable'),
  ('sgt', 'sergeant'),
  ('capt', 'captain'),
  ('esq', 'esquire'),
  ('ltd', 'limited'),
  ('col', 'colonel'),
  ('ft', 'fort'),
]]

# List of (Latin alphabet, bopomofo) pairs:
_latin_to_bopomofo = [(re.compile('%s' % x[0], re.IGNORECASE), x[1]) for x in [
  ('a', 'ㄟˉ'),
  ('b', 'ㄅㄧˋ'),
  ('c', 'ㄙㄧˉ'),
  ('d', 'ㄉㄧˋ'),
  ('e', 'ㄧˋ'),
  ('f', 'ㄝˊㄈㄨˋ'),
  ('g', 'ㄐㄧˋ'),
  ('h', 'ㄝˇㄑㄩˋ'),
  ('i', 'ㄞˋ'),
  ('j', 'ㄐㄟˋ'),
  ('k', 'ㄎㄟˋ'),
  ('l', 'ㄝˊㄛˋ'),
  ('m', 'ㄝˊㄇㄨˋ'),
  ('n', 'ㄣˉ'),
  ('o', 'ㄡˉ'),
  ('p', 'ㄆㄧˉ'),
  ('q', 'ㄎㄧㄡˉ'),
  ('r', 'ㄚˋ'),
  ('s', 'ㄝˊㄙˋ'),
  ('t', 'ㄊㄧˋ'),
  ('u', 'ㄧㄡˉ'),
  ('v', 'ㄨㄧˉ'),
  ('w', 'ㄉㄚˋㄅㄨˋㄌㄧㄡˋ'),
  ('x', 'ㄝˉㄎㄨˋㄙˋ'),
  ('y', 'ㄨㄞˋ'),
  ('z', 'ㄗㄟˋ')
]]


# List of (bopomofo, romaji) pairs:
_bopomofo_to_romaji = [(re.compile('%s' % x[0], re.IGNORECASE), x[1]) for x in [
  ('ㄅㄛ', 'p⁼wo'),
  ('ㄆㄛ', 'pʰwo'),
  ('ㄇㄛ', 'mwo'),
  ('ㄈㄛ', 'fwo'),
  ('ㄅ', 'p⁼'),
  ('ㄆ', 'pʰ'),
  ('ㄇ', 'm'),
  ('ㄈ', 'f'),
  ('ㄉ', 't⁼'),
  ('ㄊ', 'tʰ'),
  ('ㄋ', 'n'),
  ('ㄌ', 'l'),
  ('ㄍ', 'k⁼'),
  ('ㄎ', 'kʰ'),
  ('ㄏ', 'h'),
  ('ㄐ', 'ʧ⁼'),
  ('ㄑ', 'ʧʰ'),
  ('ㄒ', 'ʃ'),
  ('ㄓ', 'ʦ`⁼'),
  ('ㄔ', 'ʦ`ʰ'),
  ('ㄕ', 's`'),
  ('ㄖ', 'ɹ`'),
  ('ㄗ', 'ʦ⁼'),
  ('ㄘ', 'ʦʰ'),
  ('ㄙ', 's'),
  ('ㄚ', 'a'),
  ('ㄛ', 'o'),
  ('ㄜ', 'ə'),
  ('ㄝ', 'e'),
  ('ㄞ', 'ai'),
  ('ㄟ', 'ei'),
  ('ㄠ', 'au'),
  ('ㄡ', 'ou'),
  ('ㄧㄢ', 'yeNN'),
  ('ㄢ', 'aNN'),
  ('ㄧㄣ', 'iNN'),
  ('ㄣ', 'əNN'),
  ('ㄤ', 'aNg'),
  ('ㄧㄥ', 'iNg'),
  ('ㄨㄥ', 'uNg'),
  ('ㄩㄥ', 'yuNg'),
  ('ㄥ', 'əNg'),
  ('ㄦ', 'əɻ'),
  ('ㄧ', 'i'),
  ('ㄨ', 'u'),
  ('ㄩ', 'ɥ'),
  ('ˉ', '→'),
  ('ˊ', '↑'),
  ('ˇ', '↓↑'),
  ('ˋ', '↓'),
  ('˙', ''),
  ('，', ','),
  ('。', '.'),
  ('！', '!'),
  ('？', '?'),
  ('—', '-')
]]


def expand_abbreviations(text):
  for regex, replacement in _abbreviations:
    text = re.sub(regex, replacement, text)
  return text


def lowercase(text):
  return text.lower()


def collapse_whitespace(text):
  return re.sub(_whitespace_re, ' ', text)


def convert_to_ascii(text):
  return unidecode(text)


def number_to_chinese(text):
  numbers = re.findall(r'\d+(?:\.?\d+)?', text)
  for number in numbers:
    text = text.replace(number, cn2an.an2cn(number),1)
  return text


def chinese_to_bopomofo(text):
  text=text.replace('、','，').replace('；','，').replace('：','，')
  words=jieba.lcut(text,cut_all=False)
  text=''
  for word in words:
    bopomofos=lazy_pinyin(word,BOPOMOFO)
    if not re.search('[\u4e00-\u9fff]',word):
      text+=word
      continue
    for i in range(len(bopomofos)):
      if re.match('[\u3105-\u3129]',bopomofos[i][-1]):
        bopomofos[i]+='ˉ'
    if text!='':
      text+=' '
    text+=''.join(bopomofos)
  return text


def latin_to_bopomofo(text):
  for regex, replacement in _latin_to_bopomofo:
    text = re.sub(regex, replacement, text)
  return text


def bopomofo_to_romaji(text):
  for regex, replacement in _bopomofo_to_romaji:
    text = re.sub(regex, replacement, text)
  return text


def basic_cleaners(text):
  '''Basic pipeline that lowercases and collapses whitespace without transliteration.'''
  text = lowercase(text)
  text = collapse_whitespace(text)
  return text


def transliteration_cleaners(text):
  '''Pipeline for non-English text that transliterates to ASCII.'''
  text = convert_to_ascii(text)
  text = lowercase(text)
  text = collapse_whitespace(text)
  return text


def chinese_cleaners(text):
  '''Pipeline for Chinese text'''
  text=number_to_chinese(text)
  text=chinese_to_bopomofo(text)
  text=latin_to_bopomofo(text)
  if re.match('[ˉˊˇˋ˙]',text[-1]):
    text += '。'
  return text


def zh_ja_mixture_cleaners(text):
  chinese_texts=re.findall(r'\[ZH\].*?\[ZH\]',text)
  for chinese_text in chinese_texts:
    cleaned_text=number_to_chinese(chinese_text[4:-4])
    cleaned_text=chinese_to_bopomofo(cleaned_text)
    cleaned_text=latin_to_bopomofo(cleaned_text)
    cleaned_text=bopomofo_to_romaji(cleaned_text)
    cleaned_text=re.sub('i[aoe]',lambda x:'y'+x.group(0)[1:],cleaned_text)
    cleaned_text=re.sub('u[aoəe]',lambda x:'w'+x.group(0)[1:],cleaned_text)
    cleaned_text=re.sub('([ʦsɹ]`[⁼ʰ]?)([→↓↑]+)',lambda x:x.group(1)+'ɹ`'+x.group(2),cleaned_text).replace('ɻ','ɹ`')
    cleaned_text=re.sub('([ʦs][⁼ʰ]?)([→↓↑]+)',lambda x:x.group(1)+'ɹ'+x.group(2),cleaned_text)
    text = text.replace(chinese_text,cleaned_text+' ',1)
  text=text[:-1]
  if re.match('[A-Za-zɹəɥ→↓↑]',text[-1]):
    text += '.'
  return text
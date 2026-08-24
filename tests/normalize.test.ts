import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJsonString, normalizeAnalysis, toSnakeCase } from '../src/lib/ai/normalize';

describe('extractJsonString', () => {
  it('unwraps a fenced json block', () => {
    const raw = 'Here you go:\n```json\n{"topic":"warranty"}\n```\nHope that helps.';
    assert.equal(extractJsonString(raw), '{"topic":"warranty"}');
  });

  it('takes the widest brace span from unfenced prose', () => {
    assert.equal(extractJsonString('noise {"a":{"b":1}} trailing'), '{"a":{"b":1}}');
  });

  it('returns null when there is no object', () => {
    assert.equal(extractJsonString('no json here'), null);
    assert.equal(extractJsonString(null), null);
  });
});

describe('toSnakeCase', () => {
  it('normalises free-text topics into slugs', () => {
    assert.equal(toSnakeCase('Pricing Inquiry'), 'pricing_inquiry');
    assert.equal(toSnakeCase('order-tracking'), 'order_tracking');
    assert.equal(toSnakeCase('  Setup / Help  '), 'setup_help');
    assert.equal(toSnakeCase(''), '');
  });
});

describe('normalizeAnalysis', () => {
  it('accepts the documented response shape', () => {
    const result = normalizeAnalysis(
      JSON.stringify({
        transcript_text: 'مشتری: سلام\nفروشنده: بفرمایید',
        topic: 'pricing_inquiry',
        gender_label: 'male',
        emotion_label: 'neutral',
        answered_by: 'zahra',
        product_mention: 'JBL Flip 7',
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.analysis.topic, 'pricing_inquiry');
    assert.equal(result.analysis.genderLabel, 'male');
    assert.equal(result.analysis.emotionLabel, 'neutral');
    assert.equal(result.analysis.answeredBy, 'zahra');
    assert.equal(result.analysis.productMention, 'JBL Flip 7');
    assert.match(result.analysis.transcriptText ?? '', /فروشنده/);
  });

  it('takes the first entry when the model returns a topics array', () => {
    const result = normalizeAnalysis('{"topics":["Warranty","complaint"]}');
    assert.equal(result.analysis.topic, 'warranty');
  });

  it('maps the panel emotion aliases the same way the panel does', () => {
    assert.equal(normalizeAnalysis('{"emotion_label":"positive"}').analysis.emotionLabel, 'happy');
    assert.equal(normalizeAnalysis('{"emotion_label":"negative"}').analysis.emotionLabel, 'sad');
    assert.equal(normalizeAnalysis('{"emotion_label":"anger"}').analysis.emotionLabel, 'angry');
    assert.equal(normalizeAnalysis('{"emotion_label":"ecstatic"}').analysis.emotionLabel, 'unknown');
  });

  it('falls back to unknown for out-of-range enums and blank fields', () => {
    const result = normalizeAnalysis('{"gender_label":"robot","answered_by":"   "}');
    assert.equal(result.analysis.genderLabel, 'unknown');
    assert.equal(result.analysis.answeredBy, 'unknown');
    assert.equal(result.analysis.topic, 'unknown');
    assert.equal(result.analysis.transcriptText, null);
    assert.equal(result.analysis.productMention, null);
  });

  it('clamps product_mention to the panel column width', () => {
    const result = normalizeAnalysis(JSON.stringify({ product_mention: 'x'.repeat(400) }));
    assert.equal(result.analysis.productMention?.length, 255);
  });

  it('clamps the topic to the panel column width', () => {
    const result = normalizeAnalysis(JSON.stringify({ topic: 'a'.repeat(300) }));
    assert.equal(result.analysis.topic.length, 100);
  });

  it('forces unknown topics to "other" when asked to', () => {
    const loose = normalizeAnalysis('{"topic":"shipping_delay"}');
    assert.equal(loose.analysis.topic, 'shipping_delay');

    const strict = normalizeAnalysis('{"topic":"shipping_delay"}', { restrictToPresetTopics: true });
    assert.equal(strict.analysis.topic, 'other');
  });

  it('reports a parse failure instead of throwing, with safe fallbacks', () => {
    const result = normalizeAnalysis('I could not analyse this recording.');

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(result.analysis.topic, 'unknown');
    assert.equal(result.analysis.answeredBy, 'unknown');
  });

  it('accepts an already-parsed object', () => {
    const result = normalizeAnalysis({ topic: 'complaint', gender_label: 'female' });
    assert.equal(result.ok, true);
    assert.equal(result.analysis.topic, 'complaint');
    assert.equal(result.analysis.genderLabel, 'female');
  });
});

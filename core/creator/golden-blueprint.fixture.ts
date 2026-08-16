// TEST-ONLY golden Course Blueprint: a realistic multi-lesson course covering
// EVERY block intent kind, one `origin: 'suggested'` block, per-answer KC
// feedback, unresolved material, and a production narration entry. It is the
// compiler's regression anchor and the validator's golden "valid" input.
// Never import from production code.

import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type CourseBlueprint,
} from './blueprint/types';

const ref = (slideNo: number, label = `Slide ${slideNo}`) => ({
  label,
  slideNo,
  excerpt: `excerpt from slide ${slideNo}`,
});

export function goldenBlueprint(): CourseBlueprint {
  return {
    format: COURSE_BLUEPRINT_FORMAT,
    formatVersion: COURSE_BLUEPRINT_VERSION,
    source: {
      kind: 'ai-provider',
      originalFileName: 'golden-deck.pptx',
      provider: 'external-chat',
      model: 'test-model',
    },
    title: '1.1. Golden test course',
    lessons: [
      {
        title: 'Lesson 1 — text and structure',
        blocks: [
          {
            intent: {
              kind: 'text',
              heading: 'Welcome',
              paragraphs: ['<p>First paragraph with <strong>bold</strong>.</p>', '<p>Second.</p>'],
            },
            sourceRef: ref(1),
            notes: [],
          },
          {
            intent: {
              kind: 'list',
              ordered: true,
              heading: 'Steps overview',
              intro: ['<p>Do these in order:</p>'],
              items: ['<p>Prepare</p>', '<p>Execute</p>', '<p>Review</p>'],
              outro: ['<p>Then continue.</p>'],
            },
            sourceRef: ref(2),
            notes: [],
          },
          {
            intent: {
              kind: 'accordion',
              intro: [],
              items: [
                { title: 'Panel A', body: '<p>Body A</p>' },
                { title: 'Panel B', body: '<p>Body B</p>' },
              ],
            },
            sourceRef: ref(3),
            notes: [],
          },
          {
            intent: {
              kind: 'tabs',
              heading: 'Compare',
              intro: ['<p>Two views:</p>'],
              items: [
                { title: 'Tab 1', body: '<p>View one</p>' },
                { title: 'Tab 2', body: '<p>View two</p>' },
              ],
            },
            sourceRef: ref(4),
            notes: [],
          },
          {
            intent: { kind: 'note', paragraphs: ['<p>Remember this.</p>'] },
            sourceRef: ref(5),
            notes: [],
          },
          {
            intent: { kind: 'continue', label: 'Continue' },
            sourceRef: ref(5),
            notes: [],
          },
        ],
      },
      {
        title: 'Lesson 2 — interactions',
        blocks: [
          {
            intent: {
              kind: 'flashcards',
              intro: ['<p>Recall the terms:</p>'],
              items: [
                { title: 'Term one', body: '<p>Definition one</p>' },
                { title: 'Term two', body: '<p>Definition two</p>' },
              ],
            },
            sourceRef: ref(6),
            notes: [],
          },
          {
            intent: {
              kind: 'process',
              heading: 'The procedure',
              intro: ['<p>Four stages.</p>'],
              items: [
                { title: 'Stage 1', body: '<p>Start</p>' },
                { title: 'Stage 2', body: '<p>Middle</p>' },
              ],
            },
            sourceRef: ref(7),
            notes: [],
          },
          {
            intent: {
              kind: 'timeline',
              intro: [],
              events: [
                { date: '2001', title: 'Founding', body: '<p>It began.</p>' },
                { date: '2010', title: 'Growth', body: '<p>It grew.</p>' },
              ],
            },
            sourceRef: ref(8),
            notes: [],
          },
          {
            intent: {
              kind: 'sorting',
              intro: ['<p>Sort the cards.</p>'],
              piles: ['Fruit', 'Vegetable'],
              cards: [
                { title: 'Apple', pile: 1 },
                { title: 'Carrot', pile: 2 },
                { title: 'Pear', pile: 1 },
              ],
            },
            sourceRef: ref(9),
            notes: [],
          },
          {
            intent: {
              kind: 'links',
              heading: 'Read more',
              intro: [],
              buttons: [
                {
                  label: 'Handbook',
                  destination: 'https://example.com/handbook',
                  description: 'The full handbook.',
                },
              ],
            },
            sourceRef: ref(10),
            notes: [],
          },
          {
            // Deliberately provider-rephrased content — must carry the badge.
            intent: {
              kind: 'text',
              heading: 'Summary',
              paragraphs: ['<p>A rephrased summary of the lesson.</p>'],
            },
            sourceRef: ref(10, 'Slide 10 (summary box)'),
            notes: ['Summary condensed from bullet fragments.'],
            origin: 'suggested',
          },
        ],
      },
      {
        title: 'Lesson 3 — check and placeholders',
        blocks: [
          {
            intent: {
              kind: 'knowledge-check',
              intro: [],
              questions: [
                {
                  stem: '<p>Which are fruits?</p>',
                  options: [
                    { text: 'Apple', correct: true, feedback: 'Yes — a fruit.' },
                    { text: 'Carrot', correct: false },
                    { text: 'Pear', correct: true },
                  ],
                  feedback: '<p>Apples and pears are fruits.</p>',
                },
                {
                  stem: '<p>Pick the first stage.</p>',
                  options: [
                    { text: 'Start', correct: true },
                    { text: 'Middle', correct: false },
                  ],
                },
              ],
            },
            sourceRef: ref(11),
            notes: [],
          },
          {
            intent: { kind: 'video-placeholder', label: 'Video: intro interview (~3 min)' },
            sourceRef: ref(12),
            notes: [],
          },
          {
            intent: { kind: 'storyline-placeholder', label: 'Replace with Storyline activity — see slide 13' },
            sourceRef: ref(13),
            notes: [],
          },
          {
            intent: { kind: 'attachment-placeholder', label: 'Attachment: checklist.pdf' },
            sourceRef: ref(14),
            notes: [],
          },
        ],
      },
    ],
    assets: [],
    unresolved: [
      {
        sourceRef: ref(15, 'Slide 15 (diagram)'),
        reason: 'Complex diagram with embedded labels — no supported block; needs manual authoring.',
      },
    ],
    production: [
      {
        kind: 'narration',
        lesson: 'Lesson 3 — check and placeholders',
        sourceRef: ref(12, 'Slide 12 — Video (~3 min)'),
        text: 'Narration script for the intro interview.',
      },
    ],
  };
}

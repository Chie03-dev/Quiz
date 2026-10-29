import { QUESTION_TYPES } from './types'

export const QUESTION_GENERATION_SCHEMA = {
  '$schema': 'http://json-schema.org/draft-07/schema#',
  type: 'array',
  items: {
    type: 'object',
    required: ['type', 'body', 'points', 'data', 'key'],
    properties: {
      type: { type: 'string', enum: QUESTION_TYPES },
      body: { type: 'string' },
      points: { type: 'integer', minimum: 1 },
      data: { type: 'object' },
      key: {}
    },
    oneOf: [
      {
        properties: {
          type: { const: 'mcq' },
          data: {
            type: 'object',
            required: ['options'],
            properties: {
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'text'],
                  properties: { id: { type: 'string' }, text: { type: 'string' } }
                }
              }
            }
          },
          key: { type: 'string' }
        }
      },
      { properties: { type: { const: 'tf' }, data: { type: 'object' }, key: { type: 'boolean' } } },
      { properties: { type: { const: 'identification' }, data: { type: 'object' }, key: { type: 'array', items: { type: 'string' } } } },
      { properties: { type: { const: 'fillin' }, data: { type: 'object', required: ['blanks'], properties: { blanks: { type: 'integer', minimum: 1 } } }, key: { type: 'array' } } },
      { properties: { type: { const: 'enumeration' }, data: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } }, key: { type: 'array', items: { type: 'string' } } } },
      { properties: { type: { const: 'problem' }, data: { type: 'object' }, key: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' }, tolerance: { type: 'number' } } } } },
      { properties: { type: { const: 'matching' }, data: { type: 'object', required: ['left', 'right'], properties: { left: { type: 'array' }, right: { type: 'array' } } }, key: { type: 'object' } } },
      { properties: { type: { const: 'connect' }, data: { type: 'object', required: ['prompts', 'answers'], properties: { prompts: { type: 'array' }, answers: { type: 'array' } } }, key: { type: 'object' } } }
    ]
  }
}

export const QUESTION_JSON_SCHEMA = QUESTION_GENERATION_SCHEMA


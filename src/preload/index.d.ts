import type { QuizApi } from './index'

declare global {
  interface Window {
    quiz: QuizApi
  }
}

export {}
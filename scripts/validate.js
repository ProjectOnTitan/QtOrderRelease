// 發布紀錄的完整驗證：先用 JSON Schema 檢查形狀，通過後再檢查跨欄位規則。
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkReleaseRules } from '../assets/js/release-model.js';

export function validateReleaseData(data, schema) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  if (!ajv.validate(schema, data)) {
    return ajv.errors.map((error) => `${error.instancePath || '(根)'} ${error.message}`);
  }
  // 跨欄位規則假設形狀正確，所以只在 schema 通過後執行。
  return checkReleaseRules(data);
}

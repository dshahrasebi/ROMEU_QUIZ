'use strict';
/**
 * Server-side i18n helper.
 * Usage:  const { t } = require('./i18n-server');
 *         t('err.quiz.not_found', {}, lang)
 *
 * Placeholders in strings use {name} syntax.
 * Falls back to English if a key or locale is missing.
 */

const MESSAGES = {
  en: {
    // ── Auth ─────────────────────────────────────────────────────────────────
    'err.ratelimit':              'Too many login attempts. Try again in 15 minutes.',
    'err.unauthorized':           'Unauthorized',
    'err.csrf':                   'Invalid or missing CSRF token',

    // ── Password change ──────────────────────────────────────────────────────
    'err.pw.fields_required':     'All fields are required',
    'err.pw.mismatch':            'New passwords do not match',
    'err.pw.too_short':           'New password must be at least 8 characters',
    'err.pw.incorrect':           'Current password is incorrect',

    // ── Settings ─────────────────────────────────────────────────────────────
    'err.settings.not_object':    'Body must be a JSON object',
    'err.settings.unknown':       'Unknown setting: {key}',
    'err.settings.enum':          '{key} must be one of: {values}',
    'err.settings.bool':          '{key} must be "true" or "false"',
    'err.settings.not_int':       '{key} must be an integer',
    'err.settings.range':         '{key} must be between {min} and {max}',
    'err.settings.str_len':       '{key} must be {min}–{max} characters',
    'err.settings.color':         '{key} must be a valid hex color (e.g. #7c3aed)',
    'err.settings.url':           '{key} must be a http/https URL or empty',

    // ── Session ──────────────────────────────────────────────────────────────
    'err.session.quiz_id_required':  'quizId is required',
    'err.session.quiz_not_found':    'Quiz not found',
    'err.session.no_questions':      'Quiz must have at least one question',
    'err.session.no_active':         'No active session',
    'err.session.bad_advance':       'Cannot advance from status: {status}',
    'err.session.not_question':      'Not in question phase',
    'err.session.not_found':         'Session not found or has ended',

    // ── Quiz CRUD ────────────────────────────────────────────────────────────
    'err.quiz.name_required':     'name is required (1–100 characters)',
    'err.quiz.not_found':         'Quiz not found',

    // ── Question validation ───────────────────────────────────────────────────
    'err.q.text_required':        'text is required',
    'err.q.tf_correct_index':     'correctIndex must be 0 or 1 for true/false',
    'err.q.mcq_options':          'options must be an array of exactly 4 non-empty strings',
    'err.q.mcq_correct_range':    'correctIndex must be 0–3',
    'err.q.time_range':           'timeLimitSeconds must be 5–120',
    'err.q.not_found':            'Question not found',
    'err.q.text_empty':           'text must not be empty',
    'err.q.bad_type':             'type must be mcq or truefalse',
    'err.q.options_invalid':      'options must be an array of 2 or 4 non-empty strings',

    // ── Socket join errors ────────────────────────────────────────────────────
    'join.session_not_found':     'Session not found',
    'join.nickname_length':       'Nickname must be 1–20 chars',
    'join.profanity':             'Nickname contains inappropriate language',
    'join.already_started':       'Session has already started',
    'join.session_full':          'Session is full',
    'join.answer_locked':         'Question is no longer accepting answers',

    // ── Socket host errors ────────────────────────────────────────────────────
    'sock.unauthorized':          'Unauthorized',
    'sock.no_active_pin':         'No active session for that PIN',
    'sock.cannot_reveal':         'Cannot reveal now',
    'sock.no_active':             'No active session',
    'sock.bad_advance':           'Cannot advance from status: {status}',
  },

  es: {
    // ── Auth ─────────────────────────────────────────────────────────────────
    'err.ratelimit':              'Demasiados intentos de inicio de sesión. Inténtelo de nuevo en 15 minutos.',
    'err.unauthorized':           'No autorizado',
    'err.csrf':                   'Token CSRF inválido o ausente',

    // ── Password change ──────────────────────────────────────────────────────
    'err.pw.fields_required':     'Todos los campos son obligatorios',
    'err.pw.mismatch':            'Las contraseñas nuevas no coinciden',
    'err.pw.too_short':           'La nueva contraseña debe tener al menos 8 caracteres',
    'err.pw.incorrect':           'La contraseña actual es incorrecta',

    // ── Settings ─────────────────────────────────────────────────────────────
    'err.settings.not_object':    'El cuerpo debe ser un objeto JSON',
    'err.settings.unknown':       'Configuración desconocida: {key}',
    'err.settings.enum':          '{key} debe ser uno de: {values}',
    'err.settings.bool':          '{key} debe ser "true" o "false"',
    'err.settings.not_int':       '{key} debe ser un número entero',
    'err.settings.range':         '{key} debe estar entre {min} y {max}',
    'err.settings.str_len':       '{key} debe tener entre {min} y {max} caracteres',
    'err.settings.color':         '{key} debe ser un color hexadecimal válido (p.ej. #7c3aed)',
    'err.settings.url':           '{key} debe ser una URL http/https o estar vacío',

    // ── Session ──────────────────────────────────────────────────────────────
    'err.session.quiz_id_required':  'Se requiere el ID del cuestionario',
    'err.session.quiz_not_found':    'Cuestionario no encontrado',
    'err.session.no_questions':      'El cuestionario debe tener al menos una pregunta',
    'err.session.no_active':         'No hay sesión activa',
    'err.session.bad_advance':       'No se puede avanzar desde el estado: {status}',
    'err.session.not_question':      'No está en la fase de preguntas',
    'err.session.not_found':         'Sesión no encontrada o finalizada',

    // ── Quiz CRUD ────────────────────────────────────────────────────────────
    'err.quiz.name_required':     'El nombre es obligatorio (1–100 caracteres)',
    'err.quiz.not_found':         'Cuestionario no encontrado',

    // ── Question validation ───────────────────────────────────────────────────
    'err.q.text_required':        'El texto es obligatorio',
    'err.q.tf_correct_index':     'El índice correcto debe ser 0 o 1 para verdadero/falso',
    'err.q.mcq_options':          'Las opciones deben ser exactamente 4 cadenas no vacías',
    'err.q.mcq_correct_range':    'El índice correcto debe ser 0–3',
    'err.q.time_range':           'El límite de tiempo debe ser 5–120 segundos',
    'err.q.not_found':            'Pregunta no encontrada',
    'err.q.text_empty':           'El texto no puede estar vacío',
    'err.q.bad_type':             'El tipo debe ser mcq o truefalse',
    'err.q.options_invalid':      'Las opciones deben ser un array de 2 o 4 cadenas no vacías',

    // ── Socket join errors ────────────────────────────────────────────────────
    'join.session_not_found':     'Sesión no encontrada',
    'join.nickname_length':       'El apodo debe tener entre 1 y 20 caracteres',
    'join.profanity':             'El apodo contiene lenguaje inapropiado',
    'join.already_started':       'La sesión ya ha comenzado',
    'join.session_full':          'La sesión está llena',
    'join.answer_locked':         'La pregunta ya no acepta respuestas',

    // ── Socket host errors ────────────────────────────────────────────────────
    'sock.unauthorized':          'No autorizado',
    'sock.no_active_pin':         'No hay sesión activa con ese PIN',
    'sock.cannot_reveal':         'No se puede revelar ahora',
    'sock.no_active':             'No hay sesión activa',
    'sock.bad_advance':           'No se puede avanzar desde el estado: {status}',
  },
};

/**
 * t(key, vars, lang) → translated string with {placeholder} substitution.
 * Falls back en if key or lang is missing.
 */
function t(key, vars = {}, lang = 'en') {
  const locale = MESSAGES[lang] || MESSAGES.en;
  let str = locale[key] ?? MESSAGES.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}

module.exports = { t, MESSAGES };

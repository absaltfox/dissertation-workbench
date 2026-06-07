import { Router } from 'express';
import crypto from 'node:crypto';
import {
  clearUserMfa, countUsers, createUser, deleteUser, findUserByUsername,
  createPasswordResetToken, getAllSettings, listUsers, setSetting, updateUserPassword
} from '../db.js';
import { beginMfaSetup, createPasswordHash } from '../auth.js';
import { validateAdminUser, validateAdminUserProfile } from '../validate.js';
import { getConfiguredApiKey, isApiKeyEnvManaged, setConfiguredApiKey } from '../secrets.js';
import { asyncHandler } from '../middleware/http.js';

async function getPublicAdminSettings() {
  const settings = await getAllSettings();
  const apiKey = await getConfiguredApiKey();
  delete settings.apiKey;
  return {
    ...settings,
    apiKeyConfigured: Boolean(apiKey),
    apiKeyManagedByEnv: isApiKeyEnvManaged()
  };
}

export function createAdminUsersRouter() {
  const router = Router();

  router.get('/users', asyncHandler(async (_req, res) => {
    res.status(200).json({ users: await listUsers() });
  }));

  router.post('/users', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const profile = {
      username: String(body.username || '').trim(),
      firstName: String(body.firstName || '').trim(),
      lastName: String(body.lastName || '').trim(),
      email: String(body.email || '').trim().toLowerCase(),
    };
    const validation = validateAdminUserProfile(profile);
    if (!validation.valid) {
      res.status(400).json({ error: 'Validation failed', errors: validation.errors });
      return;
    }
    if (await findUserByUsername(profile.username)) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }
    const temporaryPassword = crypto.randomUUID() + crypto.randomUUID();
    const { hash, salt } = createPasswordHash(temporaryPassword);
    await createUser(profile.username, hash, salt, profile);
    const reset = await createPasswordResetToken(profile.username);
    const resetUrl = `${req.protocol}://${req.get('host')}/#/admin/reset-password?token=${encodeURIComponent(reset.token)}`;
    res.status(201).json({
      ok: true,
      username: profile.username,
      resetUrl,
      expiresAt: reset.expiresAt,
    });
  }));

  router.delete('/users/:username', asyncHandler(async (req, res) => {
    const username = req.params.username;
    if (req.user && username === req.user.username) {
      res.status(400).json({ error: 'Cannot delete your own admin account' });
      return;
    }
    if ((await countUsers()) <= 1) {
      res.status(400).json({ error: 'Cannot delete the last admin user' });
      return;
    }
    if (!(await deleteUser(username))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(200).json({ ok: true });
  }));

  router.put('/users/:username/password', asyncHandler(async (req, res) => {
    const username = req.params.username;
    const password = String(req.body?.password || '');
    const validation = validateAdminUser(username, password);
    if (!validation.valid) {
      res.status(400).json({ error: 'Validation failed', errors: validation.errors });
      return;
    }
    if (!(await findUserByUsername(username))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const { hash, salt } = createPasswordHash(password);
    await updateUserPassword(username, hash, salt);
    res.status(200).json({ ok: true });
  }));

  router.post('/users/:username/password-reset', asyncHandler(async (req, res) => {
    const username = req.params.username;
    if (!(await findUserByUsername(username))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const reset = await createPasswordResetToken(username);
    const resetUrl = `${req.protocol}://${req.get('host')}/#/admin/reset-password?token=${encodeURIComponent(reset.token)}`;
    res.status(200).json({ ok: true, username, resetUrl, expiresAt: reset.expiresAt });
  }));

  router.post('/me/mfa/setup', asyncHandler(async (req, res) => {
    const setup = beginMfaSetup(req.user.username);
    res.status(200).json({
      ok: true,
      setupToken: setup.token,
      secret: setup.secret,
      otpauthUrl: setup.otpauthUrl,
    });
  }));

  router.delete('/users/:username/mfa', asyncHandler(async (req, res) => {
    const username = req.params.username;
    if (!(await clearUserMfa(username))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(200).json({ ok: true });
  }));

  router.get('/settings', asyncHandler(async (_req, res) => {
    res.status(200).json({ settings: await getPublicAdminSettings() });
  }));

  router.put('/settings', asyncHandler(async (req, res) => {
    const body = req.body || {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'apiKey') continue;
      await setSetting(key, String(value));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
      const nextApiKey = String(body.apiKey || '').trim();
      if (nextApiKey) {
        try {
          await setConfiguredApiKey(nextApiKey);
        } catch (error) {
          res.status(409).json({ error: error.message });
          return;
        }
      }
    }
    res.status(200).json({ ok: true, settings: await getPublicAdminSettings() });
  }));

  return router;
}

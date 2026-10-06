import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';

const DEFAULT_PASSWORD = 'password123';

interface MailServiceLike {
  sendConfirmationEmail: (...args: unknown[]) => Promise<void>;
}

/**
 * Registers, confirms and logs a user in through the real HTTP endpoints,
 * which also creates the user's channel. Only the outgoing confirmation email
 * is intercepted, to read its token.
 */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<string> {
  const authService: unknown = app.get(AuthService);
  const { mailService } = authService as { mailService: MailServiceLike };
  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((...args: unknown[]) => {
      confirmationToken = args[2] as string;
      return Promise.resolve();
    });

  const server = app.getHttpServer();
  await request(server).post('/auth/register').send({ email, password });
  await request(server)
    .get('/auth/confirm-email')
    .query({ token: confirmationToken });
  const login = await request(server)
    .post('/auth/login')
    .send({ email, password });

  return (login.body as { access_token: string }).access_token;
}

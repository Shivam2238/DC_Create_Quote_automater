import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // close the SSH session cleanly on Ctrl+C
  const port = Number(process.env.PORT ?? 3000);
  // Localhost only: this server runs commands as root on the UAT VM.
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  Logger.log(`DC UAT Console API on http://${host}:${port}`, 'Bootstrap');
}
bootstrap();

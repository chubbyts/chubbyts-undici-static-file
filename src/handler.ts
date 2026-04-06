import { createHash, getHashes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { accessSync, constants, createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { STATUS_CODES } from 'node:http';
import { createNotFound } from '@chubbyts/chubbyts-http-error/dist/http-error';
import type { BodyInit, Handler, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response } from '@chubbyts/chubbyts-undici-server/dist/server';

export type MimeTypes = Map<string, string>;

const assertHashAlgorithm = (hashAlgorithm: string): void => {
  const supportedHashAlgorithms = getHashes();

  if (!supportedHashAlgorithms.includes(hashAlgorithm)) {
    throw new Error(
      `Not supported hash algorithm: "${hashAlgorithm}", supported are: "${supportedHashAlgorithms.join('", "')}"`,
    );
  }
};

const getStats = (filepath: string): Stats | undefined => {
  try {
    accessSync(filepath, constants.R_OK);

    return statSync(filepath);
  } catch {
    return undefined;
  }
};

const calculateHash = async (filepath: string, hashAlgorithm: string): Promise<string> => {
  return new Promise((resolve: (hash: string) => void) => {
    const hash = createHash(hashAlgorithm);
    const stream = createReadStream(filepath);

    stream.on('data', (data) => {
      hash.update(data);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
};

export const createStaticFileHandler = (
  publicDirectory: string,
  mimeTypes: MimeTypes,
  hashAlgorithm = 'md5',
): Handler => {
  assertHashAlgorithm(hashAlgorithm);

  const createResponse = (body: BodyInit, code: number, filepath: string, hash: string, stats: Stats): Response => {
    const extension = extname(filepath).slice(1);
    const mimeType = mimeTypes.get(extension);

    return new Response(body, {
      status: code,
      statusText: STATUS_CODES[code],
      headers: {
        'content-length': stats.size.toString(),
        etag: hash,
        ...(mimeType ? { 'content-type': mimeType } : {}),
      },
    });
  };

  return async (serverRequest: ServerRequest): Promise<Response> => {
    const url = new URL(serverRequest.url);

    const filepath = publicDirectory + url.pathname;

    const stats = getStats(filepath);

    if (!stats || stats.isDirectory()) {
      throw createNotFound({ detail: `There is no file at path "${url.pathname}"` });
    }

    const hash = await calculateHash(filepath, hashAlgorithm);

    if (
      serverRequest.headers
        .get('if-none-match')
        ?.split(',')
        ?.map((headerPart) => headerPart.trim())
        ?.includes(hash)
    ) {
      return createResponse(null, 304, filepath, hash, stats);
    }

    return createResponse(createReadStream(filepath), 200, filepath, hash, stats);
  };
};

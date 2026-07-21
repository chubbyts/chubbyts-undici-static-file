import { createHash, getHashes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, sep } from 'node:path';
import { STATUS_CODES } from 'node:http';
import type { HttpError } from '@chubbyts/chubbyts-http-error/dist/http-error';
import { createMethodNotAllowed, createNotFound } from '@chubbyts/chubbyts-http-error/dist/http-error';
import type { BodyInit, Handler, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response } from '@chubbyts/chubbyts-undici-server/dist/server';

export type MimeTypes = Map<string, string>;

type ResolvedFile = {
  filepath: string;
  fileHandle: FileHandle;
  size: number;
};

const assertHashAlgorithm = (hashAlgorithm: string): void => {
  const supportedHashAlgorithms = getHashes();

  if (!supportedHashAlgorithms.includes(hashAlgorithm)) {
    throw new Error(
      `Not supported hash algorithm: "${hashAlgorithm}", supported are: "${supportedHashAlgorithms.join('", "')}"`,
    );
  }
};

const resolveFile = async (
  publicDirectory: string,
  pathname: string,
  createFileNotFound: () => HttpError,
): Promise<ResolvedFile> => {
  try {
    const resolvedPublicDirectory = await realpath(publicDirectory);
    const filepath = await realpath(resolvedPublicDirectory + pathname);

    const prefix = resolvedPublicDirectory.endsWith(sep) ? resolvedPublicDirectory : resolvedPublicDirectory + sep;

    if (!filepath.startsWith(prefix)) {
      throw createFileNotFound();
    }

    // stat before open: open would block on a fifo until a writer connects
    if (!(await stat(filepath)).isFile()) {
      throw createFileNotFound();
    }

    const fileHandle = await open(filepath, 'r');

    try {
      return { filepath, fileHandle, size: (await fileHandle.stat()).size };
    } catch (e) {
      await fileHandle.close();

      throw e;
    }
  } catch {
    throw createFileNotFound();
  }
};

const calculateHash = async (fileHandle: FileHandle, hashAlgorithm: string): Promise<string> => {
  const hash = createHash(hashAlgorithm);

  for await (const data of fileHandle.createReadStream({ start: 0, autoClose: false })) {
    hash.update(data as Buffer);
  }

  return hash.digest('hex');
};

const matchesIfNoneMatch = (ifNoneMatch: string | null, etag: string): boolean => {
  if (null === ifNoneMatch) {
    return false;
  }

  return ifNoneMatch.split(',').some((part) => {
    const candidate = part.trim();

    if ('*' === candidate) {
      return true;
    }

    return (candidate.startsWith('W/') ? candidate.slice(2) : candidate) === etag;
  });
};

export const createStaticFileHandler = (
  publicDirectory: string,
  mimeTypes: MimeTypes,
  hashAlgorithm = 'md5',
): Handler => {
  assertHashAlgorithm(hashAlgorithm);

  const createResponse = (
    body: BodyInit | null,
    code: number,
    filepath: string,
    etag: string,
    size: number,
  ): Response => {
    const extension = extname(filepath).slice(1);
    const mimeType = mimeTypes.get(extension) ?? 'application/octet-stream';

    return new Response(body, {
      status: code,
      statusText: STATUS_CODES[code],
      headers: {
        'content-length': size.toString(),
        etag,
        'content-type': mimeType,
        'x-content-type-options': 'nosniff',
      },
    });
  };

  return async (serverRequest: ServerRequest): Promise<Response> => {
    const { method } = serverRequest;

    if ('GET' !== method && 'HEAD' !== method) {
      throw createMethodNotAllowed({ detail: `Method "${method}" is not allowed, allowed are "GET", "HEAD"` });
    }

    const url = new URL(serverRequest.url);

    const createFileNotFound = () => createNotFound({ detail: `There is no file at path "${url.pathname}"` });

    const { filepath, fileHandle, size } = await resolveFile(publicDirectory, url.pathname, createFileNotFound);

    const hash = await calculateHash(fileHandle, hashAlgorithm).catch(async () => {
      await fileHandle.close();

      throw createFileNotFound();
    });

    const etag = `"${hash}"`;

    if (matchesIfNoneMatch(serverRequest.headers.get('if-none-match'), etag)) {
      await fileHandle.close();

      return createResponse(null, 304, filepath, etag, size);
    }

    if ('HEAD' === method) {
      await fileHandle.close();

      return createResponse(null, 200, filepath, etag, size);
    }

    return createResponse(fileHandle.createReadStream(), 200, filepath, etag, size);
  };
};

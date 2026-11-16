import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from 'fs';
import { resolve, basename, extname, dirname } from 'path';
import { randomUUID } from 'crypto';
import type { FileAttachment } from '@open-employee/contracts/types';
import { validatePathBoundary, isExtensionBlocked, sanitizeSvgContent } from './security-guard';
import { getDataLayoutPaths, getDataRootDir, migrateLegacyDataLayout } from '../data-root';
import { redactSecrets } from '../../service/providers/redaction';

const REDACTABLE_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.log', '.csv']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ico', '.bmp']);

export interface FileManagerDesktopBridge {
  showOpenDialog?: (options: {
    title?: string;
    buttonLabel?: string;
    properties?: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  openPath?: (fullPath: string) => Promise<string>;
  showItemInFolder?: (fullPath: string) => void;
}

export interface FileManagerOptions {
  secretRedactor?: (text: string) => string;
  desktopBridge?: FileManagerDesktopBridge;
}

export class FileManager {
  private dataRootDir: string;
  private storageDir: string;
  private attachmentsDir: string;
  private configPath: string;
  private secretRedactor: (text: string) => string;
  private desktopBridge?: FileManagerDesktopBridge;

  constructor(customDataDir?: string, options?: FileManagerOptions) {
    this.dataRootDir = customDataDir || getDataRootDir();
    if (!customDataDir) {
      migrateLegacyDataLayout(this.dataRootDir);
    }
    const layout = getDataLayoutPaths(this.dataRootDir);
    this.storageDir = layout.storageDir;
    this.attachmentsDir = layout.attachmentsDir;
    this.configPath = layout.configPath;
    this.secretRedactor = options?.secretRedactor || ((text: string) => redactSecrets(text));
    this.desktopBridge = options?.desktopBridge;

    this.ensureDirectories();
    this.ensureDefaultConfig();
  }

  private redactText(text: string): string {
    if (!text) return text;
    return this.secretRedactor(redactSecrets(text));
  }

  private isRedactableTextFile(filename: string, mimeType?: string): boolean {
    const ext = extname(filename).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return false;
    }
    if (REDACTABLE_TEXT_EXTENSIONS.has(ext)) {
      return true;
    }
    if (mimeType) {
      const normalized = mimeType.toLowerCase();
      if (normalized.startsWith('text/') || normalized === 'application/json') {
        return true;
      }
    }
    return false;
  }

  private ensureDirectories(): void {
    const dirs = [this.dataRootDir, dirname(this.configPath)];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  private ensureDefaultConfig(): void {
    if (!existsSync(this.configPath)) {
      const defaultConfig = {
        storagePath: '.data',
        maxFileSizeBytes: 0, // 0 = unlimited by default
        allowedExtensions: ['*'],
        blockedExecutableExtensions: [
          '.exe',
          '.bat',
          '.cmd',
          '.sh',
          '.vbs',
          '.dylib',
          '.so',
          '.app',
          '.dll',
          '.bin'
        ],
        security: {
          sanitizeSvg: true,
          blockPathTraversal: true,
          isolatePythonEnv: true,
          pythonTimeoutSeconds: 30
        }
      };
      try {
        writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      } catch (err) {
        console.warn('Failed to write default .data/config.json:', err);
      }
    }
  }

  public getDataRootDir(): string {
    return this.dataRootDir;
  }

  /**
   * Prompts user with native file selection dialog.
   */
  public async showUploadDialog(options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }> {
    if (!this.desktopBridge?.showOpenDialog) {
      return { canceled: true, filePaths: [] };
    }

    const defaultFilters = [
      {
        name: 'Allowed Files',
        extensions: [
          'png',
          'jpg',
          'jpeg',
          'gif',
          'webp',
          'svg',
          'pdf',
          'txt',
          'md',
          'json',
          'csv',
          'ts',
          'js',
          'py',
          'html',
          'css'
        ]
      },
      { name: 'All Files', extensions: ['*'] }
    ];

    const result = await this.desktopBridge.showOpenDialog({
      title: 'Select Attachments',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters || defaultFilters
    });

    return {
      canceled: result.canceled,
      filePaths: result.filePaths || []
    };
  }

  /**
   * Saves an attachment to .data/attachments/<conversationId>/<id>_<safeName>.
   * If source is a filePath from local disk, copies the file.
   * If source is a buffer/payload, writes directly.
   */
  public async saveAttachment(
    conversationId: string,
    source:
      | string
      | {
          name: string;
          buffer: Buffer | Uint8Array | string;
          mimeType?: string;
        }
  ): Promise<FileAttachment> {
    const id = randomUUID();
    const convSafe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
    const convDir = resolve(this.attachmentsDir, convSafe);

    if (!existsSync(convDir)) {
      mkdirSync(convDir, { recursive: true });
    }

    let originalName = '';
    let size = 0;
    let mimeType = 'application/octet-stream';
    let targetFilename = '';

    if (typeof source === 'string') {
      const sourcePath = resolve(source);
      if (!existsSync(sourcePath)) {
        throw new Error(`File does not exist: ${source}`);
      }

      originalName = basename(sourcePath);

      if (isExtensionBlocked(originalName)) {
        throw new Error(`Executable file extension is blocked for security: ${originalName}`);
      }

      const safeName = originalName.replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetFilename = `${id}_${safeName}`;
      const destPath = resolve(convDir, targetFilename);

      // Verify boundary
      const boundary = validatePathBoundary(this.dataRootDir, destPath);
      if (!boundary.isSafe) {
        throw new Error('Security Error: Path traversal attempt detected.');
      }

      // Check if SVG needs sanitization or text file needs secret redaction
      if (extname(originalName).toLowerCase() === '.svg') {
        const rawContent = readFileSync(sourcePath, 'utf-8');
        const sanitized = this.redactText(sanitizeSvgContent(rawContent));
        writeFileSync(destPath, sanitized, 'utf-8');
        size = Buffer.byteLength(sanitized);
        mimeType = 'image/svg+xml';
      } else if (this.isRedactableTextFile(originalName)) {
        const rawContent = readFileSync(sourcePath, 'utf-8');
        const redacted = this.redactText(rawContent);
        writeFileSync(destPath, redacted, 'utf-8');
        size = Buffer.byteLength(redacted, 'utf-8');
        mimeType = this.guessMimeType(originalName);
      } else {
        copyFileSync(sourcePath, destPath);
        const stat = statSync(destPath);
        size = stat.size;
        mimeType = this.guessMimeType(originalName);
      }

      const relativePath = `attachments/${convSafe}/${targetFilename}`;
      return {
        id,
        name: safeName,
        originalName,
        size,
        mimeType,
        relativePath,
        absolutePath: destPath,
        createdAt: Date.now()
      };
    } else {
      originalName = source.name;

      if (isExtensionBlocked(originalName)) {
        throw new Error(`Executable file extension is blocked for security: ${originalName}`);
      }

      const safeName = originalName.replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetFilename = `${id}_${safeName}`;
      const destPath = resolve(convDir, targetFilename);

      const boundary = validatePathBoundary(this.dataRootDir, destPath);
      if (!boundary.isSafe) {
        throw new Error('Security Error: Path traversal attempt detected.');
      }

      let dataBuffer =
        typeof source.buffer === 'string'
          ? Buffer.from(source.buffer, 'utf-8')
          : Buffer.from(source.buffer);

      if (extname(originalName).toLowerCase() === '.svg') {
        const sanitized = this.redactText(sanitizeSvgContent(dataBuffer.toString('utf-8')));
        dataBuffer = Buffer.from(sanitized, 'utf-8');
        mimeType = 'image/svg+xml';
      } else {
        mimeType = source.mimeType || this.guessMimeType(originalName);
        if (this.isRedactableTextFile(originalName, mimeType)) {
          const redacted = this.redactText(dataBuffer.toString('utf-8'));
          dataBuffer = Buffer.from(redacted, 'utf-8');
        }
      }

      writeFileSync(destPath, dataBuffer);
      size = dataBuffer.length;

      const relativePath = `attachments/${convSafe}/${targetFilename}`;
      return {
        id,
        name: safeName,
        originalName,
        size,
        mimeType,
        relativePath,
        absolutePath: destPath,
        createdAt: Date.now()
      };
    }
  }

  /**
   * Saves raw text directly into a text/document attachment (useful for long paste auto-convert).
   */
  public async saveTextAttachment(
    conversationId: string,
    content: string,
    suggestedName = 'document.txt',
    mimeType = 'text/plain'
  ): Promise<FileAttachment> {
    const safeContent = this.redactText(content);
    return this.saveAttachment(conversationId, {
      name: suggestedName,
      buffer: Buffer.from(safeContent, 'utf-8'),
      mimeType
    });
  }

  /**
   * Reads attachment file data as Base64 data URL (for images) or utf-8 string.
   */
  public async readAttachment(relativePath: string): Promise<{ data: string; mimeType: string }> {
    const cleanRel = relativePath.replace(/^\.data\//, '');
    const directPath = resolve(this.dataRootDir, cleanRel);
    const storagePath = resolve(this.storageDir, cleanRel);

    const directBoundary = validatePathBoundary(this.dataRootDir, directPath);
    const storageBoundary = validatePathBoundary(this.storageDir, storagePath);
    if (!directBoundary.isSafe || !storageBoundary.isSafe) {
      throw new Error('Security Error: Path traversal attempt detected.');
    }

    const fullPath = existsSync(storagePath) ? storagePath : directPath;
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    const mimeType = this.guessMimeType(fullPath);
    const isImage = mimeType.startsWith('image/');
    const fileBuffer = readFileSync(fullPath);

    if (isImage) {
      const base64 = fileBuffer.toString('base64');
      return {
        data: `data:${mimeType};base64,${base64}`,
        mimeType
      };
    } else {
      return {
        data: fileBuffer.toString('utf-8'),
        mimeType
      };
    }
  }

  /**
   * Opens file using default OS application.
   */
  public async openExternal(pathString: string): Promise<boolean> {
    if (!this.desktopBridge?.openPath) return false;
    const fullPath = pathString.startsWith(this.dataRootDir)
      ? pathString
      : resolve(this.dataRootDir, pathString);

    const boundary = validatePathBoundary(this.dataRootDir, fullPath);
    if (!boundary.isSafe) return false;

    if (!existsSync(fullPath)) return false;
    await this.desktopBridge.openPath(fullPath);
    return true;
  }

  /**
   * Reveals file in system file manager (Finder / File Explorer).
   */
  public async showItemInFolder(pathString: string): Promise<boolean> {
    if (!this.desktopBridge?.showItemInFolder) return false;
    const fullPath = pathString.startsWith(this.dataRootDir)
      ? pathString
      : resolve(this.dataRootDir, pathString);

    const boundary = validatePathBoundary(this.dataRootDir, fullPath);
    if (!boundary.isSafe) return false;

    if (!existsSync(fullPath)) return false;
    this.desktopBridge.showItemInFolder(fullPath);
    return true;
  }

  private guessMimeType(filename: string): string {
    const ext = extname(filename).toLowerCase();
    switch (ext) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.webp':
        return 'image/webp';
      case '.svg':
        return 'image/svg+xml';
      case '.pdf':
        return 'application/pdf';
      case '.json':
        return 'application/json';
      case '.md':
        return 'text/markdown';
      case '.csv':
        return 'text/csv';
      case '.txt':
      case '.log':
      case '.ts':
      case '.js':
      case '.py':
      case '.html':
      case '.css':
        return 'text/plain';
      default:
        return 'application/octet-stream';
    }
  }
}

export const defaultFileManager = new FileManager();


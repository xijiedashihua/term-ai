/**
 * 会话层 - SFTP文件传输管理
 * 与SSH会话绑定，提供文件操作能力
 * 安全隔离：AI模块无任何权限调用SFTP操作接口
 */

const path = require('path');
const fs = require('fs');

class SFTPManager {
  /**
   * 列出远程目录内容
   */
  async list(session, remotePath = '.') {
    const sftp = await session.getSFTP();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        sftp.end();
        if (err) return reject(err);
        const items = list.map((item) => ({
          name: item.filename,
          type: this._getType(item.attrs),
          size: item.attrs.size,
          modifyTime: item.attrs.mtime * 1000,
          permissions: this._formatPermissions(item.attrs.mode),
          owner: item.attrs.uid,
          group: item.attrs.gid,
        }));
        // 排序：目录在前，文件在后
        items.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === 'directory' ? -1 : 1;
        });
        resolve(items);
      });
    });
  }

  /**
   * 上传文件
   */
  async upload(session, localPath, remotePath, onProgress) {
    const sftp = await session.getSFTP();
    return new Promise((resolve, reject) => {
      const fileSize = fs.statSync(localPath).size;
      let transferred = 0;

      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);

      readStream.on('data', (chunk) => {
        transferred += chunk.length;
        if (onProgress) {
          onProgress({ transferred, total: fileSize, percent: Math.round((transferred / fileSize) * 100) });
        }
      });

      writeStream.on('close', () => {
        sftp.end();
        resolve({ success: true, remotePath, size: fileSize });
      });

      writeStream.on('error', (err) => {
        sftp.end();
        reject(err);
      });

      readStream.on('error', (err) => {
        sftp.end();
        reject(err);
      });

      readStream.pipe(writeStream);
    });
  }

  /**
   * 下载文件
   */
  async download(session, remotePath, localPath, onProgress) {
    const sftp = await session.getSFTP();
    return new Promise((resolve, reject) => {
      // 先获取文件大小
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          sftp.end();
          return reject(err);
        }

        const fileSize = stats.size;
        let transferred = 0;

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(localPath);

        readStream.on('data', (chunk) => {
          transferred += chunk.length;
          if (onProgress) {
            onProgress({ transferred, total: fileSize, percent: Math.round((transferred / fileSize) * 100) });
          }
        });

        writeStream.on('close', () => {
          sftp.end();
          resolve({ success: true, localPath, size: fileSize });
        });

        writeStream.on('error', (err) => {
          sftp.end();
          reject(err);
        });

        readStream.on('error', (err) => {
          sftp.end();
          reject(err);
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * 删除远程文件
   */
  async delete(session, remotePath, isDirectory = false) {
    const sftp = await session.getSFTP();
    return new Promise((resolve, reject) => {
      const op = isDirectory ? 'rmdir' : 'unlink';
      sftp[op](remotePath, (err) => {
        sftp.end();
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  }

  /**
   * 重命名远程文件
   */
  async rename(session, oldPath, newPath) {
    const sftp = await session.getSFTP();
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        sftp.end();
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  }

  /**
   * 创建远程目录
   */
  async mkdir(session, remotePath) {
    const sftp = await session.getSFTP();
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        sftp.end();
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  }

  _getType(attrs) {
    if (attrs.isDirectory()) return 'directory';
    if (attrs.isSymbolicLink()) return 'symlink';
    return 'file';
  }

  _formatPermissions(mode) {
    if (!mode) return '---------';
    const perms = (mode & parseInt('777', 8)).toString(8);
    const map = { '0': '---', '1': '--x', '2': '-w-', '3': '-wx', '4': 'r--', '5': 'r-x', '6': 'rw-', '7': 'rwx' };
    return perms.split('').map((d) => map[d] || '---').join('');
  }
}

module.exports = new SFTPManager();

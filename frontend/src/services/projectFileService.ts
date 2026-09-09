import api from './api';
import { captureSession, assertSession } from './authSessionService';
import {
  FileListResponse,
  FileDetailResponse,
  FileVersionResponse,
  CreateFileRequest,
  SaveFileRequest,
  FileOperationResponse,
  DeleteFileResponse,
} from '../types/conversationFile';

export interface PushFileFromConversationRequest {
  conversation_id: string;
  filename: string;
}

export const projectFileService = {
  async listFiles(projectId: string, options: { signal?: AbortSignal } = {}): Promise<FileListResponse> {
    const response = await api.get(`/projects/${encodeURIComponent(projectId)}/files`, options);
    return response.data;
  },

  async getFile(projectId: string, filename: string, options: { signal?: AbortSignal } = {}): Promise<FileDetailResponse> {
    const encodedFilename = encodeURIComponent(filename);
    const response = await api.get(`/projects/${encodeURIComponent(projectId)}/files/${encodedFilename}`, options);
    return response.data;
  },

  async getFileVersion(
    projectId: string,
    filename: string,
    versionId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<FileVersionResponse> {
    const encodedFilename = encodeURIComponent(filename);
    const response = await api.get(
      `/projects/${encodeURIComponent(projectId)}/files/${encodedFilename}/versions/${encodeURIComponent(versionId)}`, options
    );
    return response.data;
  },

  async createFile(
    projectId: string,
    data: CreateFileRequest
  ): Promise<FileOperationResponse> {
    const response = await api.post(`/projects/${encodeURIComponent(projectId)}/files`, data);
    return response.data;
  },

  async updateFile(
    projectId: string,
    filename: string,
    data: SaveFileRequest
  ): Promise<FileOperationResponse> {
    const encodedFilename = encodeURIComponent(filename);
    const response = await api.put(
      `/projects/${encodeURIComponent(projectId)}/files/${encodedFilename}`,
      data
    );
    return response.data;
  },

  async deleteFile(projectId: string, filename: string): Promise<DeleteFileResponse> {
    const encodedFilename = encodeURIComponent(filename);
    const response = await api.delete(`/projects/${encodeURIComponent(projectId)}/files/${encodedFilename}`);
    return response.data;
  },

  async pushFileFromConversation(
    projectId: string,
    payload: PushFileFromConversationRequest
  ): Promise<FileOperationResponse> {
    const response = await api.post(`/projects/${encodeURIComponent(projectId)}/files/push-from-conversation`, payload);
    return response.data;
  },

  async uploadFile(
    projectId: string,
    file: File,
    targetPath?: string
  ): Promise<FileOperationResponse> {
    const { generation } = captureSession();
    const content = await file.text();
    assertSession(generation);
    const filename = targetPath || file.name;

    return this.createFile(projectId, {
      filename,
      summary: `Uploaded file: ${file.name}`,
      content,
      log: 'Uploaded from local file system',
    });
  },
};

export default projectFileService;

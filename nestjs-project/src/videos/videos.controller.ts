import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { PartUrlsRequestDto } from './dto/part-urls-request.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoPublicIdParamDto } from './dto/video-public-id-param.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoPlaybackService } from './video-playback.service';
import { VideoUploadService } from './video-upload.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videoUploadService: VideoUploadService,
    private readonly videoPlaybackService: VideoPlaybackService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers an 'uploading' draft on the caller's channel and opens a multipart upload. The client then sends the parts directly to storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videoUploadService.initiate(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue presigned part upload URLs',
    description:
      'Signs UploadPart URLs (valid for 3600 s) for a batch of up to 100 parts, in the request order. The client PUTs the raw part bytes to each URL.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs issued',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR) or a part number exceeds part_count (PART_NUMBER_OUT_OF_RANGE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: "The video is not in 'uploading' status",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
    @Body() dto: PartUrlsRequestDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videoUploadService.presignPartUrls(
      user.sub,
      params.publicId,
      dto.part_numbers,
    );
  }

  @Get(':publicId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored for an in-progress upload, so an interrupted upload can resume.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stored parts, ascending by part_number',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: "The video is not in 'uploading' status",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
  ): Promise<UploadedPartsResponseDto> {
    return this.videoUploadService.listUploadedParts(user.sub, params.publicId);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel an in-progress upload',
    description:
      'Deletes the draft, aborts the multipart upload and removes any stored bytes.',
  })
  @ApiResponse({ status: 204, description: 'Upload cancelled' })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: "The video is not in 'uploading' status",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
  ): Promise<void> {
    await this.videoUploadService.cancel(user.sub, params.publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete an upload and start processing',
    description:
      "Assembles the stored parts, re-checks the real object size, moves the video to 'processing' and enqueues it. Idempotent while the video is 'processing'.",
  })
  @ApiResponse({
    status: 202,
    description: "Upload completed; the video is now 'processing'",
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      "The video is 'ready' or 'failed' (INVALID_UPLOAD_STATE), or parts are missing or invalid (UPLOAD_INCOMPLETE)",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'The stored object exceeds 10 GiB',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
  ): Promise<VideoResponseDto> {
    return this.videoUploadService.complete(user.sub, params.publicId);
  }

  @Get(':publicId')
  @ApiOperation({
    summary: 'Get an owned video',
    description:
      "Returns the video's status and extracted metadata, for polling while it is 'processing'. When 'ready', thumbnail_url is a presigned GET valid for 900 s; otherwise it is null.",
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
  ): Promise<VideoResponseDto> {
    return this.videoPlaybackService.getOwnedVideo(user.sub, params.publicId);
  }

  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a presigned GET of the original file, valid for 6 h, that the browser fetches directly from storage with HTTP Range requests.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL issued',
    type: PresignedUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: "The video is not 'ready'",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
  ): Promise<PresignedUrlResponseDto> {
    return this.videoPlaybackService.getStreamUrl(user.sub, params.publicId);
  }

  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned GET of the original file, valid for 15 min, served with Content-Disposition: attachment and the original filename.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL issued',
    type: PresignedUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed publicId',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown publicId, or the video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: "The video is not 'ready'",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParamDto,
  ): Promise<PresignedUrlResponseDto> {
    return this.videoPlaybackService.getDownloadUrl(user.sub, params.publicId);
  }
}

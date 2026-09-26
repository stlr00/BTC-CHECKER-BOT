import { Module } from '@nestjs/common';
import { MempoolApiService } from './mempool-api.service.js';
import { MempoolSocketService } from './mempool-socket.service.js';

@Module({
  providers: [MempoolApiService, MempoolSocketService],
  exports: [MempoolApiService, MempoolSocketService],
})
export class MempoolModule {}

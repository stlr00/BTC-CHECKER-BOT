import { Module } from '@nestjs/common';
import { MempoolModule } from '../mempool/mempool.module.js';
import { PricesService } from './prices.service.js';

@Module({
  imports: [MempoolModule],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
